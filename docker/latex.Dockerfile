# Minimal TeX Live image used as the LaTeX compile sandbox.
# The backend invokes this image per-job via `docker run --rm` with the
# job's /tmp/peermind_jobs/{job_id}/source directory mounted at /workspace.
FROM texlive/texlive:latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      latexmk \
      python3-pygments \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Defensive defaults: non-interactive, no network, fail fast.
ENV TEXMFVAR=/tmp/texmf-var
ENTRYPOINT ["latexmk"]
CMD ["-pdf", "-f", "-shell-escape", "-interaction=nonstopmode", "main.tex"]
