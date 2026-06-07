#!/bin/bash
# Replace API URL placeholder with env variable
sed "s|%%API_URL%%|${NEXT_PUBLIC_API_URL}|g" index.html > index.built.html
mv index.built.html index.html
echo "Build complete — API: ${NEXT_PUBLIC_API_URL}"