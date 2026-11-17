FROM joseluisq/static-web-server:2.44.3
COPY storybook-static /public
COPY packaging/storybook/sws.toml /etc/sws.toml
ENV SERVER_CONFIG_FILE=/etc/sws.toml
USER 65532:65532
EXPOSE 8080
