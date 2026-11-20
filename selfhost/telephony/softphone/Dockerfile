FROM smart-cs-telephone-lab:20261116
RUN apk add --no-cache asterisk-srtp ca-certificates
COPY server/ /lab/server/
COPY telephony/ /lab/telephony/
RUN chmod 755 /lab/telephony/softphone/incoming.cjs
CMD ["node", "telephony/softphone/service.cjs"]
