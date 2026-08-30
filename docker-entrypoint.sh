#!/bin/sh
set -e

CERT_PATH="${CERT_PATH:-/app/certs/cert.pem}"
KEY_PATH="${KEY_PATH:-/app/certs/key.pem}"
CERT_SAN_DNS="${CERT_SAN_DNS:-questlog.local}"
CERT_SAN_IP="${CERT_SAN_IP:-}"

if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ]; then
  echo "No cert found at $CERT_PATH, generating a self-signed one..."
  mkdir -p "$(dirname "$CERT_PATH")"

  SAN="DNS:${CERT_SAN_DNS},DNS:localhost"
  if [ -n "$CERT_SAN_IP" ]; then
    SAN="${SAN},IP:${CERT_SAN_IP}"
  fi

  openssl req -x509 -newkey rsa:2048 -keyout "$KEY_PATH" -out "$CERT_PATH" \
    -days 3650 -nodes -subj "/CN=${CERT_SAN_DNS}" -addext "subjectAltName=${SAN}"
  chmod 600 "$KEY_PATH"
  echo "Cert generated (SAN: ${SAN})."
else
  echo "Using existing cert at $CERT_PATH."
fi

exec "$@"
