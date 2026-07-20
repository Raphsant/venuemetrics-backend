FROM node:24-alpine
WORKDIR /app
COPY server.js .
# SQLite lives on /data — mount a volume there or the db dies with the container.
VOLUME /data
ENV DB_PATH=/data/venue.db
EXPOSE 8080
# Runs as root: bind-mounted ./data dirs are root-owned when Docker creates them,
# and a non-root user can't open the SQLite file there (ERR_SQLITE_ERROR errcode 14).
CMD ["node", "server.js"]
