# demo.anypress.site: WordPress Playground, built from its official source by the Build Playground workflow and served as
# static files. The dashboard's demo pages (/demo) embed it.
FROM caddy:2.10-alpine
ARG PLAYGROUND=playground-v3.1.64
ADD https://github.com/hamchowderr/waas-provisioning-api/releases/download/${PLAYGROUND}/playground.tar.gz /tmp/playground.tar.gz
RUN mkdir -p /srv && tar -xzf /tmp/playground.tar.gz -C /srv && rm /tmp/playground.tar.gz
# The AnyPress name and ribbon on the browser tab, a saved bookmark and a shared link, in place of Playground's.
COPY brand/ /srv/
RUN sed -i -e 's|<title>WordPress Playground</title>|<title>AnyPress demo</title>|' \
      -e 's|content="WordPress Playground"|content="AnyPress demo"|' \
      -e 's|content="https://playground.wordpress.net/"|content="https://demo.anypress.site/"|' \
      -e 's|<link rel="icon" type="image/x-icon" href="/favicon.ico" />|<link rel="icon" type="image/svg+xml" href="/icon.svg" /><link rel="icon" sizes="48x48" href="/favicon.ico" />|' \
      /srv/index.html /srv/remote.html \
 && grep -q '<title>AnyPress demo</title>' /srv/index.html && grep -q '<title>AnyPress demo</title>' /srv/remote.html
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
