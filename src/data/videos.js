import { SCANNED_VIDEOS } from "virtual:video-library";

// Fallback catalog if /public/videos/ is empty
const FALLBACK_VIDEOS = [
  {
    id: "sample1",
    title: "Sample Stream 01",
    course: "Sample Library",
    section: "Main",
    description: "1080p • Local Direct Stream",
    duration: "04:12",
    src: "/videos/sample1.mp4",
    subtitleSrc: "",
    poster: ""
  }
];

// Automatically populated from all subdirectories in /public/videos/
export const VIDEO_LIBRARY =
  SCANNED_VIDEOS && SCANNED_VIDEOS.length > 0
    ? SCANNED_VIDEOS
    : FALLBACK_VIDEOS;


