# Sandbox image for agent tools and skills.
#
# Built locally rather than pulled: `bun run sandbox:build` from apps/api.
# SANDBOX_IMAGE points at the tag this produces.
#
# No LibreOffice on purpose — it adds 600MB-1GB and is only needed for format
# conversion (docx->pdf). Creating documents from scratch does not need it.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Debian marks its Python as externally managed; these are the only packages in
# the image and there is no system Python to protect, so installing into it is
# the simplest correct thing here.
RUN pip3 install --no-cache-dir --break-system-packages \
      openpyxl==3.1.5 \
      python-docx==1.1.2

# Global installs are not on the default resolution path for a script running
# from an arbitrary cwd, so NODE_PATH makes them importable from the workspace.
RUN npm install -g exceljs@4.4.0 docx@9.0.2 pdf-lib@1.17.1
ENV NODE_PATH=/usr/local/lib/node_modules

# Skills are bind-mounted read-only here at run time; the directory exists so a
# container started without the mount fails on a missing skill, not a missing path.
RUN mkdir -p /skills
