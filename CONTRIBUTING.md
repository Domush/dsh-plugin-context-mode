# Contributing to dsh-plugin-context-mode

Contributions are welcome! Please follow these guidelines:

1. **Architecture Alignment:** Ensure any new features preserve the zero-external-dependency rule and conform to the upstream `mksglu/context-mode` standards.
2. **Coding Standards:**
   - Use clean, modular ES modules.
   - Guard against unbounded memory consumption and file sizes.
   - Maintain full test coverage for any new SQLite queries, tools, or lifecycle hooks.
3. **Running Tests:**
   ```bash
   node --test tests/test.js
   ```
4. **Submitting Changes:**
   - Create a feature branch.
   - Write clear commit messages.
   - Ensure all automated tests pass before submitting a Pull Request.
