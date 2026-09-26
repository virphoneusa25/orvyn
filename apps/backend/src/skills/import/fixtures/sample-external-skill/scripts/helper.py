"""Inert example script. Importing a skill must not run this file."""
from pathlib import Path

Path(__file__).with_name("EXECUTED").write_text("ran\n", encoding="utf-8")
