from redis_client import set_memory, get_memory

def test_redis_connection():
    test_key = "jarvis:test"
    test_value = "system_online"
    
    print(f"Setting key '{test_key}' to '{test_value}'...")
    success = set_memory(test_key, test_value)
    if success:
        print("Set operation successful.")
    else:
        print("Set operation failed.")
        return

    print(f"Reading back key '{test_key}'...")
    retrieved_value = get_memory(test_key)
    print(f"Retrieved value: {retrieved_value}")
    
    if retrieved_value == test_value:
        print("Test passed: The retrieved value matches the stored value.")
    else:
        print("Test failed: Values do not match.")

if __name__ == "__main__":
    test_redis_connection()
