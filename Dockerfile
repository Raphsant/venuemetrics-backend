FROM node:24-alpine
WORKDIR /app
COPY server.js .
# SQLite lives on /data — mount a volume there or the db dies with the container.
VOLUME /data
ENV DB_PATH=/data/venue.db
EXPOSE 8080
USER node
CMD ["node", "server.js"]
