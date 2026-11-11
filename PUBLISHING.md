# Publishing checklist

This folder is a clean copy of the project with no git history. Nothing has been published: every step below is yours, by hand.

- [ ] **Review the folder.** Open it and skim the files, the README and the screenshots in `docs/shots/`. The export already ran an automated check for emails, phone numbers, your profile and answers, your git identity, your home path, your applied/skipped job ids and your private eval data, but you are the last line of defence.
- [ ] **Make it a new repository on this machine.**
  ```
  cd export/job-radar-public
  git init
  git add -A
  git commit -m "Initial commit"
  ```
  Check the author line of that commit (`git log -1`) and use a no-reply address if you do not want your real email public.
- [ ] **Create a NEW public GitHub repository** (do not reuse or flip the private one: its history holds early job-posting snapshots and your commit email). Leave it empty: no README, no licence, no .gitignore.
- [ ] **Push** to the new repository (`git remote add origin <url>`, then `git branch -M main` and `git push -u origin main`).
- [ ] **Turn on the demo site.** Repository Settings -> Pages -> Build and deployment -> Deploy from a branch -> Branch `main`, folder `/docs` -> Save.
- [ ] **Check the demo URL** (it appears on the Pages settings screen after a minute or two). It must show the SAMPLE DATA banner and invented companies only.
- [ ] Optional: add the repository and the demo link to your portfolio site and LinkedIn.

The private repository's history is never exported. To refresh the public copy later, run `npm run export:public -- --force` again and repeat the steps in a fresh clone or by copying the files over; never push the private repository.
