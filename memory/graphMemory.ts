/**
 * memory/graphMemory.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Graph database memory using Neo4j.
 * Stores semantic relationships between entities.
 *
 * Phase 3 additions:
 *   - Duplicate prevention: MERGE semantics hardened with property timestamps;
 *     saveRelation() also records a `lastSeen` property so stale edges can be pruned.
 *   - cleanupRelationships(staleAfterDays): removes edges not seen in N days.
 *   - validateConsistency(): checks for orphaned nodes (no edges) and returns report.
 *   - getRelationStats(): counts nodes, edges, and orphans without full traversal.
 *
 * Requirements:
 *   - neo4j-driver
 *   - NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env
 */

import neo4j, { Driver, Session } from "neo4j-driver";

export class GraphMemory {
  private driver: Driver | null = null;
  private isConnected = false;

  constructor() {
    const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
    const user = process.env.NEO4J_USER || "neo4j";
    const password = process.env.NEO4J_PASSWORD;
    const enabled = process.env.JARVIS_NEO4J_ENABLED === "true";

    try {
      if (enabled && !password) {
        // Previously defaulted to the literal "password" (JARVIS-020). Refuse to
        // connect rather than silently trying a well-known credential.
        this.isConnected = false;
        console.error(
          "[GraphMemory] JARVIS_NEO4J_ENABLED=true but NEO4J_PASSWORD is not set. " +
          "Graph memory is disabled. Set NEO4J_PASSWORD in .env to enable it.",
        );
      } else if (enabled && password) {
        this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
          connectionAcquisitionTimeout: 2000,
        });
        this.isConnected = true;
        console.log("[GraphMemory] Initialized Neo4j driver connection.");
      } else {
        this.isConnected = false;
        console.log("[GraphMemory] Neo4j disabled.");
      }
    } catch (err) {
      console.error("[GraphMemory] Failed to initialize Neo4j driver:", err);
      this.isConnected = false;
    }
  }

  /**
   * Safely gets a session if connected.
   */
  private getSession(): Session | null {
    if (!this.isConnected || !this.driver) return null;
    return this.driver.session();
  }

  /**
   * Exposes graph availability so callers can avoid unnecessary Neo4j work.
   */
  isAvailable(): boolean {
    return this.isConnected && this.driver !== null;
  }

  /**
   * Stores a relationship between two entities.
   * e.g., saveRelation("User", "WORKS_ON", "EcommerceApp")
   * 
   * @param entity1 Subject entity name (e.g. "User")
   * @param relation Relationship type (e.g. "WORKS_ON")
   * @param entity2 Object entity name (e.g. "EcommerceApp")
   */
  /**
   * Stores a relationship between two entities.
   * Uses MERGE semantics (idempotent) — duplicate edges are NOT created.
   * Sets a `lastSeen` timestamp on every merge for stale-edge cleanup.
   */
  async saveRelation(entity1: string, relation: string, entity2: string): Promise<void> {
    if (!this.isAvailable()) return;
    const session = this.getSession();
    if (!session) return;

    try {
      const relType = relation.toUpperCase().replace(/[^A-Z_]/g, "");
      if (!relType) {
        console.warn(`[GraphMemory] Skipping saveRelation: relation "${relation}" produced an empty type after sanitisation.`);
        return;
      }
      const query = `
        MERGE (e1:Entity {name: $entity1})
        MERGE (e2:Entity {name: $entity2})
        MERGE (e1)-[r:${relType}]->(e2)
        ON CREATE SET r.createdAt = $now, r.lastSeen = $now
        ON MATCH  SET r.lastSeen = $now
        RETURN e1, r, e2
      `;
      await session.run(query, { entity1, entity2, now: Date.now() });
      console.log(`[GraphMemory] Saved: (${entity1})-[${relType}]->(${entity2})`);
    } catch (err) {
      console.error(`[GraphMemory] Error saving relation (${entity1})-[${relation}]->(${entity2}):`, err);
    } finally {
      await session.close();
    }
  }

  async queryRelations(entity: string): Promise<Array<{ source: string; relation: string; target: string }>> {
    if (!this.isAvailable()) return [];
    const session = this.getSession();
    if (!session) return [];

    try {
      const query = `
        MATCH (n:Entity {name: $entity})-[r]->(m:Entity)
        RETURN n.name AS source, type(r) AS relation, m.name AS target
        UNION
        MATCH (m:Entity)-[r]->(n:Entity {name: $entity})
        RETURN m.name AS source, type(r) AS relation, n.name AS target
      `;

      const result = await session.run(query, { entity });
      return result.records.map((record: any) => ({
        source: record.get("source"),
        relation: record.get("relation"),
        target: record.get("target"),
      }));
    } catch (err) {
      console.error(`[GraphMemory] Error querying relations for '${entity}':`, err);
      return [];
    } finally {
      await session.close();
    }
  }

  async traverseGraphContext(entities: string[], maxDepth: number = 2): Promise<Array<{ source: string; relation: string; target: string }>> {
    if (!this.isAvailable() || entities.length === 0) return [];
    const session = this.getSession();
    if (!session) return [];

    try {
      // APOC is typically used for advanced traversal, but we can use Cypher paths 
      // with variable-length relationships for basic depth control.
      // We prune branches by limiting path length.
      
      const query = `
        MATCH p = (start:Entity)-[*1..${maxDepth}]-(related:Entity)
        WHERE start.name IN $entities
        UNWIND relationships(p) AS rel
        WITH startNode(rel) AS sourceNode, rel, endNode(rel) AS targetNode
        RETURN DISTINCT sourceNode.name AS source, type(rel) AS relation, targetNode.name AS target
        LIMIT 50
      `;

      const result = await session.run(query, { entities });

      const relations = result.records.map((record: any) => ({
        source: record.get("source"),
        relation: record.get("relation"),
        target: record.get("target"),
      }));

      return relations;
    } catch (err) {
      console.error(`[GraphMemory] Error traversing context for entities ${entities}:`, err);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * SSOT: Stores a full Fact node in Neo4j.
   */
  async saveFact(fact: any): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    try {
      const query = `
        MERGE (f:Fact {id: $id})
        SET f.text = $text,
            f.importance = $importance,
            f.confidence = $confidence,
            f.version = $version,
            f.lastAccessed = $lastAccessed,
            f.accessCount = $accessCount
      `;
      await session.run(query, {
        id: fact.id,
        text: fact.fact,
        importance: fact.importance,
        confidence: fact.confidence,
        version: fact.version,
        lastAccessed: fact.lastAccessed,
        accessCount: fact.accessCount
      });
    } catch (err) {
      console.error(`[GraphMemory] Error saving Fact ${fact.id} to Neo4j:`, err);
    } finally {
      await session.close();
    }
  }

  /**
   * SSOT: Retrieves all facts from Neo4j.
   */
  async getAllFacts(): Promise<any[]> {
    const session = this.getSession();
    if (!session) return [];
    try {
      const query = `MATCH (f:Fact) RETURN f`;
      const result = await session.run(query);
      return result.records.map(r => {
        const props = r.get("f").properties;
        return {
          id: props.id,
          fact: props.text,
          importance: props.importance || 5,
          confidence: props.confidence || 0.8,
          version: props.version || 1,
          lastAccessed: props.lastAccessed || Date.now(),
          accessCount: props.accessCount || 0
        };
      });
    } catch (err) {
      console.error("[GraphMemory] Error retrieving facts:", err);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Executes a custom Cypher query.
   */
  async queryGraph(query: string, parameters?: any): Promise<any[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const session = this.getSession();
    if (!session) {
      return [];
    }
    try {
      const result = await session.run(query, parameters);
      return result.records.map((record: any) => {
        const obj: any = {};
        record.keys.forEach((key: string) => {
          obj[key] = record.get(key);
        });
        return obj;
      });
    } catch (err) {
      console.error("[GraphMemory] Error executing queryGraph:", err);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Closes the Neo4j driver connection.
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.isConnected = false;
      console.log("[GraphMemory] Connection closed.");
    }
  }

  // ─── Phase 3: Relationship cleanup, dedup, consistency validation ───────────────

  /**
   * Remove edges that have not been seen (lastSeen) in the past N days.
   * This prevents the graph from growing unbounded with stale relationships.
   *
   * @param staleAfterDays  Edges older than this are deleted (default: 30 days)
   * @returns               Number of edges removed
   */
  async cleanupRelationships(staleAfterDays = 30): Promise<number> {
    if (!this.isAvailable()) return 0;
    const session = this.getSession();
    if (!session) return 0;

    const cutoffMs = Date.now() - staleAfterDays * 86_400_000;
    try {
      // Only delete edges that have a `lastSeen` property set (i.e. written by Phase 3+)
      const result = await session.run(`
        MATCH ()-[r]->()
        WHERE r.lastSeen IS NOT NULL AND r.lastSeen < $cutoff
        WITH r, startNode(r) AS s, endNode(r) AS e
        DELETE r
        RETURN count(r) AS removed
      `, { cutoff: cutoffMs });

      const removed = result.records[0]?.get('removed')?.toNumber?.() ?? 0;
      if (removed > 0) {
        console.log(`[GraphMemory] cleanupRelationships: removed ${removed} edges older than ${staleAfterDays} days.`);
      }

      // Also delete orphaned Entity nodes (no edges in either direction)
      await session.run(`
        MATCH (n:Entity)
        WHERE NOT (n)--() 
        DELETE n
      `);

      return removed;
    } catch (err) {
      console.error('[GraphMemory] cleanupRelationships error:', err);
      return 0;
    } finally {
      await session.close();
    }
  }

  /**
   * Consistency validation.
   * Checks for:
   *   - Entity nodes with no edges (orphans)
   *   - Fact nodes with missing required properties
   *   - Duplicate Entity names (should not happen with MERGE, but validates)
   *
   * Returns a structured report. Does NOT mutate data.
   */
  async validateConsistency(): Promise<{
    orphanedNodes: string[];
    factsWithMissingFields: string[];
    duplicateEntityNames: string[];
    isConsistent: boolean;
  }> {
    if (!this.isAvailable()) {
      return { orphanedNodes: [], factsWithMissingFields: [], duplicateEntityNames: [], isConsistent: true };
    }
    const session = this.getSession();
    if (!session) {
      return { orphanedNodes: [], factsWithMissingFields: [], duplicateEntityNames: [], isConsistent: true };
    }

    try {
      // 1. Orphaned entity nodes
      const orphanResult = await session.run(`
        MATCH (n:Entity)
        WHERE NOT (n)--()
        RETURN n.name AS name LIMIT 50
      `);
      const orphanedNodes = orphanResult.records.map(r => String(r.get('name')));

      // 2. Facts with missing required properties
      const factsResult = await session.run(`
        MATCH (f:Fact)
        WHERE f.id IS NULL OR f.text IS NULL
        RETURN coalesce(f.id, '<no-id>') AS id LIMIT 50
      `);
      const factsWithMissingFields = factsResult.records.map(r => String(r.get('id')));

      // 3. Duplicate Entity names (count > 1 for same name)
      const dupResult = await session.run(`
        MATCH (n:Entity)
        WITH n.name AS name, count(n) AS cnt
        WHERE cnt > 1
        RETURN name LIMIT 20
      `);
      const duplicateEntityNames = dupResult.records.map(r => String(r.get('name')));

      const isConsistent = orphanedNodes.length === 0
        && factsWithMissingFields.length === 0
        && duplicateEntityNames.length === 0;

      if (!isConsistent) {
        console.warn(
          `[GraphMemory] Consistency check found issues: ` +
          `${orphanedNodes.length} orphans, ${factsWithMissingFields.length} bad facts, ` +
          `${duplicateEntityNames.length} duplicate names.`
        );
      }

      return { orphanedNodes, factsWithMissingFields, duplicateEntityNames, isConsistent };
    } catch (err) {
      console.error('[GraphMemory] validateConsistency error:', err);
      return { orphanedNodes: [], factsWithMissingFields: [], duplicateEntityNames: [], isConsistent: true };
    } finally {
      await session.close();
    }
  }

  /**
   * Lightweight diagnostic stats: node count, edge count, orphan count.
   * Does not perform a full traversal — uses COUNT aggregation only.
   */
  async getRelationStats(): Promise<{ nodes: number; edges: number; orphans: number; facts: number }> {
    if (!this.isAvailable()) return { nodes: 0, edges: 0, orphans: 0, facts: 0 };
    const session = this.getSession();
    if (!session) return { nodes: 0, edges: 0, orphans: 0, facts: 0 };

    try {
      const result = await session.run(`
        MATCH (n:Entity) WITH count(n) AS nodes
        OPTIONAL MATCH ()-[r]->() WITH nodes, count(r) AS edges
        OPTIONAL MATCH (o:Entity) WHERE NOT (o)--() WITH nodes, edges, count(o) AS orphans
        OPTIONAL MATCH (f:Fact) RETURN nodes, edges, orphans, count(f) AS facts
      `);
      const record = result.records[0];
      return {
        nodes:   record?.get('nodes')?.toNumber?.()   ?? 0,
        edges:   record?.get('edges')?.toNumber?.()   ?? 0,
        orphans: record?.get('orphans')?.toNumber?.() ?? 0,
        facts:   record?.get('facts')?.toNumber?.()   ?? 0,
      };
    } catch (err) {
      console.error('[GraphMemory] getRelationStats error:', err);
      return { nodes: 0, edges: 0, orphans: 0, facts: 0 };
    } finally {
      await session.close();
    }
  }
}

export const graphMemory = new GraphMemory();
