import sys
import json

class PythonBridge:
    """
    Listens on stdin, executes commands, returns JSON.
    """
    def __init__(self):
        self.running = True

    def run(self):
        print("[PythonBridge] Started listening on stdin...", file=sys.stderr)
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                
                request = json.loads(line)
                response = self.handle_request(request)
                
                sys.stdout.write(json.dumps(response) + "\n")
                sys.stdout.flush()
            except Exception as e:
                error_response = {"status": "error", "message": str(e)}
                sys.stdout.write(json.dumps(error_response) + "\n")
                sys.stdout.flush()

    def handle_request(self, request):
        action = request.get("action")
        payload = request.get("payload", {})
        
        # Route to different python modules based on action
        if action == "ping":
            return {"status": "success", "data": "pong"}
        else:
            return {"status": "unknown_action", "action": action}

if __name__ == "__main__":
    bridge = PythonBridge()
    bridge.run()
