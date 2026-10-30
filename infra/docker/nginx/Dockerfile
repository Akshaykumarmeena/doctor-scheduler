# The load balancer for a cloud host (written for Railway, kept for later; Phase 9): nginx in front of api-1 and
# api-2, Phase 6's setup moved off the laptop. Private only: the web app reaches it; it gets no public domain.
# 1.28: `server … resolve` in an upstream (re-resolve names when Railway moves a container) needs nginx >= 1.27.3.
FROM nginx:1.28-alpine
# The official image runs envsubst on /etc/nginx/templates/*.template at start, writing /etc/nginx/conf.d/*.conf.
# NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 fills ${NGINX_LOCAL_RESOLVERS} with the container's DNS server
# (on Railway: its private DNS), so nginx can look up the API services by name.
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
