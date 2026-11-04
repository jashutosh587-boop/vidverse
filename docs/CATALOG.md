# The catalog of public-domain video

With `CATALOG_IMPORT=on`, the site fills three channels it owns with public-domain films and footage, so visitors have
something to watch before creators arrive.

| Channel | Source | What is taken |
| --- | --- | --- |
| Space Archive (`@space-archive`) | NASA Image and Video Library | Videos from 15 searches (Apollo, ISS, Mars rovers, Hubble, Artemis…), up to 25 each |
| Vintage Shorts (`@vintage-shorts`) | Prelinger Archives on the Internet Archive | Up to 220 films, most-watched first, made up to 1965 |
| Silent Cinema (`@silent-cinema`) | Feature films on the Internet Archive | Up to 60 films made up to 1930 |

`CATALOG_MAX_VIDEOS` (default 800) caps the whole catalog. The source list is `DEFAULT_SOURCES` in
`src/services/catalog/index.js`.

## Why these, and the rules applied to every item

- **NASA:** NASA-produced media is generally not subject to copyright in the United States. NASA's own guidelines warn
  that some items include material owned by others, so anything whose title, description or keywords mention
  "courtesy of", "copyright", "©", a news agency and similar words is refused. NASA's logo and name must not be used
  to suggest endorsement, which is why the channel says it is not affiliated with NASA.
- **Internet Archive:** only items whose licence field is the Public Domain Mark or CC0, *and* old enough to be public
  domain in both the United States and India. In India a film is public domain 60 years after the year it was
  published, so 1965 or earlier. In the United States, works from before 1931 are public domain by age. Prelinger
  films (1930s to 1960s) also carry Rick Prelinger's public-domain dedication.
- **Playable everywhere:** each file is read with ffprobe on the server and taken only if it is H.264 video with AAC or
  MP3 audio (or none), between 10 seconds and 3 hours long. Anything else is skipped.
- **Credit:** every catalog video shows its source, credit and licence under the player, with a link to the original.

A licence field on an archive is what the archive or uploader says. It is a strong signal, not a guarantee. If a rights
holder writes in, remove the video (below); the copyright page already explains how to reach you.

## How it works

- It runs as background jobs, one page of one source per job. A run starts once a day (and when the site starts),
  continues where it stopped after a restart, and only ever adds new items.
- The videos play from the archives' own servers. Nothing is stored here but a 640x360 thumbnail of about 25 KB
  per video, in `DATA_DIR`. That keeps storage and bandwidth costs near zero, and it means a video stops playing if the
  archive removes it or is down.
- Items that were refused are recorded in the `catalog_skips` table with the reason, and are never fetched again.
- The site's logs show one line per page (`catalog page`) and one at the end (`catalog run finished`) with the number of
  videos per channel.

## Removing a video

Remove it as staff from the admin console, like any other video. Removed videos are deleted after 30 days, and a
deleted catalog video is added to `catalog_skips`, so it is never imported again.

## Things to know

- **Ads.** Google AdSense looks for original content. A site that is mostly re-hosted archive video may be refused or
  limited, however legal the video is. Catalog videos follow `ADS_DEFAULT_ELIGIBLE` like uploads; set it to `false`
  before importing if you want them without ads.
- **Privacy.** Playing a catalog video connects the viewer's browser to the archive. The privacy policy says so.
- **Views are real.** Catalog videos start at zero views and likes; nothing is made up.
