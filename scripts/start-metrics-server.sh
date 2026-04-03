#!/bin/bash
# Start the metrics server if not already running
METRICS_PID=$(pgrep -f 'metrics-server.py' 2>/dev/null)
if [ -n "$METRICS_PID" ]; then
    echo "Metrics server already running (PID: $METRICS_PID)"
else
    nohup python3 /relay/scripts/metrics-server.py 9100 > /tmp/metrics-server.log 2>&1 &
    echo "Metrics server started (PID: $!)"
fi
