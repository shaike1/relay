#!/usr/bin/env python3
"""Lightweight metrics HTTP server for relay dashboard.
Serves /metrics (HTML dashboard) and /api/relay-metrics (JSON data).
Default port: 9100
"""
import http.server
import subprocess
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9100
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
METRICS_HTML = os.path.join(SCRIPT_DIR, '..', 'metrics.html')
METRICS_SCRIPT = os.path.join(SCRIPT_DIR, 'metrics.sh')


class MetricsHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/relay-metrics':
            try:
                result = subprocess.run(
                    ['bash', METRICS_SCRIPT],
                    capture_output=True, text=True, timeout=15
                )
                body = result.stdout or '[]'
            except Exception:
                body = '[]'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body.encode())

        elif self.path in ('/', '/metrics'):
            try:
                with open(METRICS_HTML) as f:
                    body = f.read()
            except FileNotFoundError:
                body = '<h1>metrics.html not found</h1>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(body.encode())

        else:
            self.send_error(404)

    def log_message(self, format, *args):
        pass  # Suppress access logs


if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), MetricsHandler)
    print(f'Metrics server listening on port {PORT}')
    server.serve_forever()
