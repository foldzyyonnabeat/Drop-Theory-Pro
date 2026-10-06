# Offline track-analysis references

These fixtures are local WAV excerpts from real tracks. The worker test reads
them from disk and makes no network requests or uploads. The three original
stable-reference clips and the three added cross-style clips are 24 seconds
long; the two syncopation cases are 30 seconds long.

## Labels and tolerances

- BPM references come from the `tempo` field in the Free Music Archive (FMA)
  Echo Nest features (`echonest.csv`). These are independent published
  estimates, not artist-certified ground truth. Accept an estimate within
  **±4 BPM** of one of the listed beat-level references.
- Key and mode come from the original expert-labeled FMAK dataset by Stella
  Wong and Gandalf Hernandez. Require an exact pitch-class and mode match;
  enharmonic spellings (for example, A♯ and B♭) count as the same key.
- The added clips use the FMAK v1 labels, not the later FMAKv2 revisions.
  BPM alternatives below are the explicitly accepted half- or double-time
  interpretations; do not infer additional aliases.
- “Time Flux” is the tempo-ambiguity case: its 115.010 BPM reference may also
  be read at half-time, 57.505 BPM. Either reading is accepted within ±4 BPM.
- “The Narrative Changes” has a 93 BPM reference and may also be read at
  half-time, 46.5 BPM. Either pulse is accepted within ±4 BPM; an ambiguous
  syncopated passage may instead return no BPM estimate.

## Source data and audio attribution

The FMA audio files are licensed by their respective artists; the FMA dataset
authors explicitly state that the audio uses the license chosen by each
artist. The FMA metadata is CC BY 4.0. Tempo references are from the FMA
`echonest.csv` metadata, and key references are from the original expert
annotated FMAK release (CC BY 4.0, DOI
[10.5281/zenodo.10719860](https://doi.org/10.5281/zenodo.10719860)).

### Existing Revolution Void excerpts

These original fixtures are from **Revolution Void**, licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). They are modified
versions (24-second excerpts, converted to mono 11,025 Hz, 16-bit PCM) of:

| Fixture | Track | FMA source | BPM reference | Key reference | Excerpt starts |
| --- | --- | --- | ---: | --- | ---: |
| `time-flux.wav` | “Time Flux” | [FMA track page](https://freemusicarchive.org/music/Revolution_Void/The_Politics_of_Desire/revolution_void_-_02_-_time_flux/) | 115.010 or 57.505 | B♭ minor | 60 s |
| `time-flux-syncopated.wav` | “Time Flux” | [FMA track page](https://freemusicarchive.org/music/Revolution_Void/The_Politics_of_Desire/revolution_void_-_02_-_time_flux/) | 115.010 | Not asserted | 15 s |
| `telluric-undercurrent.wav` | “Telluric Undercurrent” | [FMA track page](https://freemusicarchive.org/music/Revolution_Void/The_Politics_of_Desire/revolution_void_-_05_-_telluric_undercurrent/) | 115.988 | C minor | 30 s |
| `scattered-knowledge.wav` | “Scattered Knowledge” | [FMA track page](https://freemusicarchive.org/music/Revolution_Void/The_Politics_of_Desire/revolution_void_-_10_-_scattered_knowledge/) | 87.995 | F♯ minor | 90 s |
| `the-narrative-changes-syncopated.wav` | “The Narrative Changes” | [FMA track page](https://freemusicarchive.org/music/Revolution_Void/The_Politics_of_Desire/revolution_void_-_09_-_the_narrative_changes/) | 93.0 or 46.5 | Not asserted | 30 s |

### Cross-style additions

Each license below was checked against that track's own `license_title` and
`license_url` fields in the FMA `raw_tracks.csv` metadata, not inferred from the
dataset's general license. Each listed CC BY license allows adapted excerpts
with attribution.

| Fixture | Style (FMA top-level genre) | Track and source | BPM reference(s) accepted (±4) | Expert key | Excerpt starts | Track license |
| --- | --- | --- | --- | --- | ---: | --- |
| `octopussy-rock.wav` | Rock | Juanitos, “Octopussy” (FMA ID 23172), [track page](https://freemusicarchive.org/music/Juanitos/Exotica/juanitos_-_01_-_octopussy) | 96.123 | A minor | 20 s | [CC BY 2.0 France](https://creativecommons.org/licenses/by/2.0/fr/) |
| `digital-lightning-rock.wav` | Rock | Cloudkicker, “Digital Lightning” (FMA ID 112315), [track page](https://freemusicarchive.org/music/Cloudkicker/Little_histories/Cloudkicker_-_Little_Histories_-_04_Digital_Lightning) | 176.993 or 88.4965 (half-time) | F♯ major | 10 s | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `stickybee-folk.wav` | Folk / acoustic | Josh Woodward, “Stickybee” (FMA ID 88846), [track page](https://freemusicarchive.org/music/Josh_Woodward/Dirty_Wings/JoshWoodward-DW-02-Stickybee) | 87.909 or 175.818 (double-time) | E minor | 5 s | [CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/) |

Attribution for the new excerpts: Juanitos, “Octopussy,” from *Exotica*, CC BY
2.0 France; Cloudkicker, “Digital Lightning,” from *Little Histories*, CC BY
4.0; and Josh Woodward, “Stickybee,” from *Dirty Wings*, CC BY 3.0 US. All via
Free Music Archive. Each is shortened to 24 seconds and converted to mono
11,025 Hz, 16-bit PCM for local tests.

The existing Revolution Void files are from FMA IDs 39580 (“Time Flux”), 39583
(“Telluric Undercurrent”), 39588 (“Scattered Knowledge”), and 39587 (“The
Narrative Changes”). FMA's dataset and metadata provenance is documented in
the [FMA repository](https://github.com/mdeff/fma) (Defferrard et al., ISMIR
2017); track audio rights remain those selected by each artist.