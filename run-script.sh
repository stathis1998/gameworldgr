#!/bin/bash

# Load .env file, skipping comments and empty lines
set -o allexport
source <(grep -v '^#' /root/moose/gameworldgr/.env | grep -v '^\s*$')
set +o allexport

# Change to project directory
cd /root/moose/gameworldgr

# Use full path to Node from nvm
/root/.nvm/versions/node/v24.14.1/bin/node dist/index.js >> /root/moose/gameworldgr/cron.log 2>&1
