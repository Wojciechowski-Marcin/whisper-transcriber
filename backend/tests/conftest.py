import os
import tempfile

# Point persistence at a temp dir before app.main is imported, so module import
# (which creates the JobStore root) never touches the default /data/outputs.
os.environ.setdefault("OUTPUT_DIR", tempfile.mkdtemp(prefix="whisper-test-"))
