# jarvis-media

A short-lived, key-protected media drop for JARVIS. Instagram's API fetches the photo or video of a
post from a public link, so JARVIS uploads the file here, gives Instagram the link, and deletes the
file once the post is out. Files also expire after `MAX_AGE_H` hours (24). Nothing is listed or indexed.

- `POST /u` with `Authorization: Bearer $MEDIA_KEY` and the file as the body: `201 { id, url, bytes, type }`
- `DELETE /u/<id>` with the key: `204`
- `GET /m/<id>.jpg|mp4|mov`: the file (public, with Range)

Only JPEG, MP4 and MOV are taken (checked by their first bytes). Without `MEDIA_KEY` (32+ characters)
nothing can be uploaded. JARVIS makes the key (Settings, Platforms, Media server); it goes into the
server's environment, never into this repo.

Env: `MEDIA_KEY`, `PORT` (3000), `DATA_DIR`, `MAX_MB` (500), `MAX_TOTAL_MB` (3000), `MAX_AGE_H` (24), `PUBLIC_URL`.
