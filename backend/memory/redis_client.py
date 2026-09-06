import redis
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class RedisClient:
    def __init__(self, host="localhost", port=6379):
        try:
            self.client = redis.Redis(
                host=host,
                port=port,
                decode_responses=True,
                protocol=2
            )
            self.client.ping()
            logger.info(f"Connected to Redis at {host}:{port}")
        except redis.ConnectionError as e:
            logger.error(f"Failed to connect to Redis: {e}")
            self.client = None

    def set_memory(self, key, value):
        if not self.client:
            logger.error("Redis client is not connected.")
            return False
        try:
            return self.client.set(key, value)
        except redis.RedisError as e:
            logger.error(f"Error setting memory for key '{key}': {e}")
            return False

    def get_memory(self, key):
        if not self.client:
            logger.error("Redis client is not connected.")
            return None
        try:
            return self.client.get(key)
        except redis.RedisError as e:
            logger.error(f"Error getting memory for key '{key}': {e}")
            return None

    def delete_memory(self, key):
        if not self.client:
            logger.error("Redis client is not connected.")
            return False
        try:
            return self.client.delete(key) > 0
        except redis.RedisError as e:
            logger.error(f"Error deleting memory for key '{key}': {e}")
            return False

# Export a default instance for easy import
default_client = RedisClient()

def set_memory(key, value):
    return default_client.set_memory(key, value)

def get_memory(key):
    return default_client.get_memory(key)

def delete_memory(key):
    return default_client.delete_memory(key)
