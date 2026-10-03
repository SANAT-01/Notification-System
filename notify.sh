#!/bin/sh
# notify.sh [--crash|--crash-claim|--bad-token]  -> fire one notification event.
#   (no flag)      push + email to user 7
#   --crash        push worker dies after send, before ack (duplicate demo)
#   --crash-claim  push worker dies right after claiming, before ever sending
#                  (claim-but-never-sent recovery demo)
#   --bad-token    user 999, invalid device token (retry + dead-letter demo)
cd /root/lab3 || exit 1
docker compose exec -T producer python /app/publish.py "$@"
