# demo.anypress.site: WordPress Playground, built from its official source by the Build Playground workflow and served as
# static files. The dashboard's demo pages (/demo) embed it.
FROM caddy:2.10-alpine
ARG PLAYGROUND=playground-v3.1.62
ADD https://github.com/hamchowderr/waas-provisioning-api/releases/download/${PLAYGROUND}/playground.tar.gz /tmp/playground.tar.gz
RUN mkdir -p /srv && tar -xzf /tmp/playground.tar.gz -C /srv && rm /tmp/playground.tar.gz
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
