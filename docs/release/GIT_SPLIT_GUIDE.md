# Split Git Guide (Extension and Library)

Use two repositories:

1. **Extension repo** (this project)
2. **Library repo** (firmware-side avr-stub library if you maintain your own fork)

---

## Extension repository (Repo A)

Suggested content:

- `src/`, `media/`, `docs/`, `README.md`, `LICENSE`, `package.json`, `tsconfig.json`
- optionally built `.vsix` attached as GitHub Release asset (not committed to main branch)

Suggested steps:

```powershell
git init
git add .
git commit --trailer "Made-with: Cursor" -m "Initial release: Arduino AVR Stub Debug extension"
```

Then push:

```powershell
git branch -M main
git remote add origin <your-extension-repo-url>
git push -u origin main
```

---

## Library repository (Repo B)

If you maintain a custom AVR debug library fork, keep it separate.

Suggested content:

- library source files
- examples
- README and LICENSE

Suggested steps:

```powershell
git init
git add .
git commit --trailer "Made-with: Cursor" -m "Initial release: AVR debug library"
```

Then push:

```powershell
git branch -M main
git remote add origin <your-library-repo-url>
git push -u origin main
```

---

## Why split repositories

- clear ownership and versioning boundaries
- independent release cadence (extension vs firmware library)
- easier issue tracking and CI pipelines
