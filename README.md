Building an agentic RAG with a few bespoke features; intended to be used later on to parse my entries. 


- datasets/: raw downloads and caches (e.g., SQuAD JSON, Hotpot raw JSON, WikiSQL tarball and extracted datasets/data/*). Used as immutable inputs.
- data/: processed artifacts used by retrieval and evaluation runtime.
- data/docs/: plain-text doc corpus built from SQuAD/Hotpot.
- data/tables/: CSV tables built from WikiSQL.