"""AI features that run on the server: reading sheet music from PDFs/photos and finding sheet music online.

The model calls live in `claude.py`; everything else (layout detection, the compact notation the model
writes, checking bar lengths, writing MusicXML) is deterministic code that is unit-tested without the API.
"""
