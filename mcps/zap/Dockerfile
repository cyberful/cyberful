FROM ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2

LABEL org.opencontainers.image.title="cyberful-zap" \
      org.opencontainers.image.description="Headless OWASP ZAP 2.17.0 runtime for Cyberful" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.cyberful.zap.version="2.17.0" \
      org.cyberful.zap.addons="ascanrules=83,spiderAjax=23.32.0,authhelper=0.40.0,graphql=0.33.0,mcp=0.2.0,oast=0.24.0,openapi=57,pscanrules=75,reports=0.46.0,websocket=37"

USER root
RUN rm -f \
  /zap/plugin/onlineMenu-*.zap \
  /zap/plugin/quickstart-*.zap \
  /zap/plugin/ascanrules-*.zap \
  /zap/plugin/spiderAjax-*.zap \
  /zap/plugin/authhelper-*.zap \
  /zap/plugin/graphql-*.zap \
  /zap/plugin/mcp-*.zap \
  /zap/plugin/oast-*.zap \
  /zap/plugin/openapi-*.zap \
  /zap/plugin/pscanrules-*.zap \
  /zap/plugin/reports-*.zap \
  /zap/plugin/websocket-*.zap
# callhome is mandatory in ZAP 2.17.0. It remains installed, while -silent and -notel in the entrypoint
# prohibit update, news, and telemetry requests.
ADD --checksum=sha256:9c1b64c2fceda629f7c0ab0c21b5901035494f78da51d584972eaf85e94e91cc \
  https://github.com/zaproxy/zap-extensions/releases/download/ascanrules-v83/ascanrules-release-83.zap \
  /zap/plugin/ascanrules-release-83.zap
ADD --checksum=sha256:9850bb21d7d1ecf8593740069d1eae75b02fb7eefa19af54244c277677031500 \
  https://github.com/zaproxy/zap-extensions/releases/download/spiderAjax-v23.32.0/spiderAjax-release-23.32.0.zap \
  /zap/plugin/spiderAjax-release-23.32.0.zap
ADD --checksum=sha256:8618464c4959dcb90b81e1770304a2a3a0dc4ba31c8a72e518fa95ff0ecf9c01 \
  https://github.com/zaproxy/zap-extensions/releases/download/authhelper-v0.40.0/authhelper-beta-0.40.0.zap \
  /zap/plugin/authhelper-beta-0.40.0.zap
ADD --checksum=sha256:22f1246a302ef42b7eec9af340cc732494025a5fd6a0322d717dfccb44c5b8b3 \
  https://github.com/zaproxy/zap-extensions/releases/download/graphql-v0.33.0/graphql-alpha-0.33.0.zap \
  /zap/plugin/graphql-alpha-0.33.0.zap
ADD --checksum=sha256:adc8692a30bf6f23e5b597b95726f1588f4bd7d34ab57280481a91cbe35aca88 \
  https://github.com/zaproxy/zap-extensions/releases/download/mcp-v0.2.0/mcp-alpha-0.2.0.zap \
  /zap/plugin/mcp-alpha-0.2.0.zap
ADD --checksum=sha256:f06ecea02e2c1df4a164e737dd632afba4430225b2fdc2feb6042bdb1e976b3d \
  https://github.com/zaproxy/zap-extensions/releases/download/oast-v0.24.0/oast-beta-0.24.0.zap \
  /zap/plugin/oast-beta-0.24.0.zap
ADD --checksum=sha256:fe87dd63cb310131c4e7d8c14b675c97f4b7707eda8ccc5fd6042628b6f19ccf \
  https://github.com/zaproxy/zap-extensions/releases/download/openapi-v57/openapi-beta-57.zap \
  /zap/plugin/openapi-beta-57.zap
ADD --checksum=sha256:97814c5f1319a31b5041f1bbd1edfc312b3a539c7cd56f7903e9996858361fcb \
  https://github.com/zaproxy/zap-extensions/releases/download/pscanrules-v75/pscanrules-release-75.zap \
  /zap/plugin/pscanrules-release-75.zap
ADD --checksum=sha256:2e8d42a48e23aefa8a6174b52aa0a8a6b90aca2da0a8bf94ac61f4aaa070bc2c \
  https://github.com/zaproxy/zap-extensions/releases/download/reports-v0.46.0/reports-release-0.46.0.zap \
  /zap/plugin/reports-release-0.46.0.zap
ADD --checksum=sha256:f2c3035976531130494b5b9dfc02ca0ebd7e0388f740f68b6d4e775098be9fc6 \
  https://github.com/zaproxy/zap-extensions/releases/download/websocket-v37/websocket-release-37.zap \
  /zap/plugin/websocket-release-37.zap
COPY zap-entrypoint.sh /usr/local/bin/cyberful-zap
RUN chown zap:zap /zap/plugin/*.zap && chmod 0755 /usr/local/bin/cyberful-zap
USER zap

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cyberful-zap"]
