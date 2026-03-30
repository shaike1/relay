#!/bin/bash
# Start nomacode web terminal if not already running
if ! pgrep -f 'nomacode.js' > /dev/null 2>&1; then
    cd /root/nomacode
    HOST=0.0.0.0 nohup node bin/nomacode.js --port 3334 --no-open > /tmp/nomacode.log 2>&1 &
    echo "Nomacode started on port 3334"
else
    echo "Nomacode already running"
fi
