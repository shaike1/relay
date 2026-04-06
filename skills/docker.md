# Docker Skill

You have access to Docker. When managing containers:
- Use `docker ps` to list running containers
- Use `docker logs <name>` for diagnostics
- Use `docker exec <name> <cmd>` to run commands in containers
- Prefer `docker restart <name>` over stop+start for quick fixes
- Always check `docker inspect` before making changes to running containers
