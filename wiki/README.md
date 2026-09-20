# Wiki source

These markdown files are the source for the project's GitHub Wiki. GitHub's wiki
is a separate git repo (`<repo>.wiki.git`) that only exists after the first page
is created in the UI, so these are kept here and published from a local machine.

## Publish to the GitHub Wiki

1. In the repo, open the **Wiki** tab and click **Create the first page** →
   **Save** (this initializes `Chrome-extension.wiki.git`).
2. From your machine:

   ```bash
   git clone https://github.com/bronglil/Chrome-extension.wiki.git
   cp /path/to/Chrome-extension/wiki/*.md Chrome-extension.wiki/
   cd Chrome-extension.wiki
   git add -A && git commit -m "Publish wiki pages" && git push
   ```

Page filenames map to titles (e.g. `Testing-and-CI.md` → “Testing and CI”), and
`_Sidebar.md` renders the sidebar navigation.
