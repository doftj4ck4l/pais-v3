# Sandbox image for agent tools and skills.
#
# Built locally rather than pulled: `bun run sandbox:build` from apps/api.
# SANDBOX_IMAGE points at the tag this produces.
#
# Everything here is preinstalled for one reason: the reaper removes an idle
# container after SANDBOX_IDLE_MS (5 minutes), and a `pip install` lands in the
# container layer rather than the workspace. Anything the agent installs itself
# is gone by the next conversation and gets installed again, forever. Image size
# costs a build, not a run — `acquire` starts a container from an image that is
# already local — so a package that gets installed twice belongs in this file.
#
# The list is deliberately narrower than E2B's or Bedrock's (both ship GB-scale
# images, Bedrock 200+ packages including torch). No torch, spacy, librosa or
# gensim: nothing has asked, and they are the packages that turn 1GB into 4GB.
#
# No LibreOffice on purpose — it adds 600MB-1GB and is only needed for format
# conversion (docx->pdf). Creating documents from scratch does not need it.
#
# trixie rather than bookworm for two things the agent actually reaches for:
# ImageMagick 7, whose binary is `magick` (bookworm ships 6, where only
# `convert` exists and `magick` reads as "no image tooling here"), and Python
# 3.13. Node 24 is the Active LTS; 22 has been security-only since Oct 2025.
FROM node:24-trixie-slim

# bash: the `bash` tool runs `bash -lc`, so pin it rather than leaning on the
#   Debian base shipping it — the model writes here-strings and `[[ ]]` that dash
#   rejects.
# curl: the model reaches for it to fetch URLs from bash; without it every such
#   command died code 127 (measured).
# ghostscript: `ps2pdf` and PDF post-processing — another 127 in the traces.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ghostscript python3 python3-pip imagemagick \
 && rm -rf /var/lib/apt/lists/*

# Debian marks its Python as externally managed; these are the only packages in
# the image and there is no system Python to protect, so installing into it is
# the simplest correct thing here.
#
# Versions are pinned so a rebuild months from now produces the image that was
# tested, not whatever PyPI resolves that day. Grouped by what asked for them.
RUN pip3 install --no-cache-dir --break-system-packages \
      `# documents` \
      openpyxl==3.1.5 \
      python-docx==1.2.0 \
      python-pptx==1.0.2 \
      pypdf==6.16.1 \
      `# reportlab for generating PDFs from scratch — the model tried reportlab` \
      `# and fpdf and found neither, then thrashed for a PDF path (measured)` \
      reportlab==4.2.5 \
      `# images — pillow for scripted edits, opencv headless because the plain` \
      `# wheel drags in an X11/libGL chain for a GUI nothing here can show` \
      pillow==12.3.0 \
      opencv-python-headless==5.0.0.93 \
      `# data` \
      numpy==2.5.2 \
      pandas==3.0.5 \
      scipy==1.18.0 \
      scikit-learn==1.9.0 \
      tabulate==0.10.0 \
      `# charts` \
      matplotlib==3.11.1 \
      seaborn==0.13.2 \
      plotly==6.9.0 \
      `# fetching and parsing` \
      requests==2.34.2 \
      beautifulsoup4==4.15.0 \
      lxml==6.1.1

# Global installs are not on the default resolution path for a script running
# from an arbitrary cwd, so NODE_PATH makes them importable from the workspace.
RUN npm install -g exceljs@4.4.0 docx@9.0.2 pdf-lib@1.17.1
ENV NODE_PATH=/usr/local/lib/node_modules

# When the preinstalled set misses something, the agent should be able to
# `pip install` it for the life of the container instead of dead-ending on
# Debian's PEP 668 "externally-managed-environment" (measured: the model tried
# `pip install fpdf2` and was refused, with no way forward). There is no system
# Python here to protect, so let runtime installs land in site-packages too.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Skills are bind-mounted read-only here at run time; the directory exists so a
# container started without the mount fails on a missing skill, not a missing path.
RUN mkdir -p /skills
