#!/usr/bin/env python3
"""Install pinned Compound Engineering skills for this project's coding agents."""

import io
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile


REPOSITORY = "EveryInc/compound-engineering-plugin"
REVISION = "4ba48871919650d43a412e3faf0374272fdc209d"
ROOT = Path(__file__).resolve().parent.parent


def main():
    url = f"https://codeload.github.com/{REPOSITORY}/zip/{REVISION}"
    with urllib.request.urlopen(url, timeout=60) as response:
        archive_bytes = response.read()
    with tempfile.TemporaryDirectory(prefix="compound-skills-") as temporary:
        source = Path(temporary)
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            prefix = f"compound-engineering-plugin-{REVISION}/"
            for member in archive.infolist():
                relative = member.filename.removeprefix(prefix)
                if relative != "LICENSE" and not relative.startswith("skills/"):
                    continue
                path = source / relative
                if not path.resolve().is_relative_to(source.resolve()):
                    raise RuntimeError("Archive contains an invalid path")
                if member.is_dir():
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(archive.read(member))
        skills = sorted(path.parent for path in (source / "skills").glob("*/SKILL.md"))
        if len(skills) != 37:
            raise RuntimeError(f"Expected 37 skills, found {len(skills)}")
        destination = ROOT / ".agents/skills"
        targets = [ROOT / folder / "skills" for folder in (".claude", ".cursor", ".pi")]
        for skill in skills:
            installed = destination / skill.name
            if installed.is_symlink():
                raise RuntimeError(f"Refusing to replace existing symlink: {installed}")
            if installed.exists():
                expected = {p.relative_to(skill): p.read_bytes() for p in skill.rglob("*") if p.is_file()}
                actual = {p.relative_to(installed): p.read_bytes() for p in installed.rglob("*") if p.is_file()}
                if actual != expected:
                    raise RuntimeError(f"Existing skill differs; preserve or move it first: {installed}")
            for target in targets:
                link = target / skill.name
                if (link.exists() or link.is_symlink()) and not (
                    link.is_symlink() and link.resolve() == installed.resolve()
                ):
                    raise RuntimeError(f"Refusing to replace existing skill: {link}")
        destination.mkdir(parents=True, exist_ok=True)
        for skill in skills:
            installed = destination / skill.name
            if not installed.exists():
                shutil.copytree(skill, installed)
            for target in targets:
                target.mkdir(parents=True, exist_ok=True)
                link = target / skill.name
                if not link.is_symlink():
                    link.symlink_to(Path("../../.agents/skills") / skill.name, target_is_directory=True)
        metadata = ROOT / ".agents/compound-engineering"
        metadata.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / "LICENSE", metadata / "LICENSE")
        (metadata / "SOURCE").write_text(f"https://github.com/{REPOSITORY}\nRevision: {REVISION}\n")
        print(f"Installed {len(skills)} Compound Engineering skills at {REVISION}")
        print("Available in .agents/skills, .claude/skills, .cursor/skills and .pi/skills")


if __name__ == "__main__":
    main()
