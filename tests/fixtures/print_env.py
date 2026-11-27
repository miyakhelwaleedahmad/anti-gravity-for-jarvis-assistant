# Test fixture (childEnvCoverageTest): prints the names of the variables it was started with.
import json
import os
print("ENV:" + json.dumps(sorted(os.environ)) + ":END", flush=True)
