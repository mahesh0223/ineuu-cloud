# Thin wrapper around the official SearXNG image, just overriding settings.yml so the
# JSON API (what INEUU Slate's AI chat calls for web-search grounding) is actually enabled -
# it's off by default in stock SearXNG for anti-scraping reasons.
FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml

EXPOSE 8080
