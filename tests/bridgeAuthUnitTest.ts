async function runTests() {
  process.env.JARVIS_BRIDGE_TOKEN = 'unit-test-token';
  process.env.JARVIS_BRIDGE_DEV_MODE = 'false';

  const { getBridgeAuthStatus, isBridgeTokenValid } = await import('../bridge/nodeBridge.js');

  let passed = 0;
  let failed = 0;

  function ok(label: string, condition: boolean) {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  console.log('\n=== NodeBridge Auth Unit Tests ===\n');

  const status = getBridgeAuthStatus();
  ok('token is required outside dev mode', status.requiresToken === true);
  ok('token is configured', status.tokenConfigured === true);
  ok('correct token is accepted', isBridgeTokenValid('unit-test-token') === true);
  ok('missing token is rejected', isBridgeTokenValid(undefined) === false);
  ok('wrong token is rejected', isBridgeTokenValid('wrong-token') === false);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
