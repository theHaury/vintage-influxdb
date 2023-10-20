import axios from "axios";
import fs from "fs";
import path from "path";
import writeToDb from "../influxDb/writeToDb";
import { requestRefreshedAccessToken } from "../spotifyAuth/spotifyAuth";
import { Measurer } from "../utils/measureDuration";

let projectPath = "";
if (process.env.TS_NODE_DEV == "true") {
  projectPath = path.join(__dirname, "..", "..", "spotifyKeys.json");
} else {
  projectPath = path.join(__dirname, "..", "..", "..", "spotifyKeys.json");
}

let currentAccessToken = "";
let currentRefreshToken = "";
let running = false;

function getCurrentlyPlaying() {
  return axios.get("https://api.spotify.com/v1/me/player", {
    headers: {
      Authorization: `Bearer ${currentAccessToken}`,
    },
  });
}

function getAudioFeatures(id: string) {
  return axios
    .get(`https://api.spotify.com/v1/audio-features/${id}`, {
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
      },
    })
    .then((response) => response.data as TrackFeatures);
}

function getArtistInfo(id: string) {
  return axios
    .get(`https://api.spotify.com/v1/artists/${id}`, {
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
      },
    })
    .then((response) => response.data as ArtistInfo);
}

function getAlbumInfo(id: string) {
  return axios
    .get(`https://api.spotify.com/v1/albums/${id}`, {
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
      },
    })
    .then((response) => response.data as AlbumInfo);
}

const durationMeasurer = new Measurer();

async function recordData(): Promise<void> {
  console.log("Starting to record data...");
  let appRunning = false;

  while (running) {
    try {
      const response = await getCurrentlyPlaying();
      const timestamp = new Date();
      const spotifyData = response.data as NowPlayingTrack;

      if (response.status === 429) {
        // Handle rate limit error
        const retryAfter = Number(response.headers['retry-after']) || 60; // Default to 60 seconds
        console.log(`Rate limit exceeded. Waiting for ${retryAfter} seconds.`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue; // Skip the rest of the loop and try the request again.
      }
      else {
        if (response.status != 204 && spotifyData?.item.id) {
          appRunning = true;

          const trackFeatures = await getAudioFeatures(spotifyData.item.id);
          const artistInfo = await getArtistInfo(spotifyData.item.artists[0].id);
          const albumInfo = await getAlbumInfo(spotifyData.item.album.id);

          const result = durationMeasurer.checkTimer(
            spotifyData,
            { trackFeatures, artistInfo, albumInfo },
            timestamp
          );

          if (result) {
            // If there was a change
            writeToDb(
              result.track,
              result.additionalTrackInfo.trackFeatures,
              result.additionalTrackInfo.artistInfo,
              result.additionalTrackInfo.albumInfo,
              result.seconds,
              timestamp
            );
          }
        } else if (appRunning) {
          // Spotify app was closed
          console.log("Spotify was closed");
          const result = durationMeasurer.quitApp(timestamp);
          if (result.seconds != 2) {
            writeToDb(
              result.track,
              result.additionalTrackInfo.trackFeatures,
              result.additionalTrackInfo.artistInfo,
              result.additionalTrackInfo.albumInfo,
              result.seconds,
              timestamp
            );
          }
          appRunning = false;
        }
      }
    } catch (e) {
      console.error(e);
      running = false;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // when access token is invalidated
  prepareToRecordData();
  return Promise.resolve();
}

function prepareToRecordData(): void {
  fs.readFile(projectPath, async (err, data) => {
    if (!err) {
      try {
        const parsedJSON = JSON.parse(data.toString());
        currentRefreshToken = parsedJSON.refresh_token;

        console.log("Refreshing token...");
        currentAccessToken = await requestRefreshedAccessToken(
          currentRefreshToken
        );
        running = true;
        recordData();
      } catch (e) {
        console.error(e);
        console.error("Error refreshing token. Try deleting spotifyKeys.json");
      }
    } else {
      console.error(err);
    }
  });
}

export { prepareToRecordData };
