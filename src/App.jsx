import React, { useState, useEffect, useMemo, useCallback } from "react";
import Navbar from "./components/Navbar";
import VideoPlayer from "./components/VideoPlayer";
import VideoGrid from "./components/VideoGrid";
import { VIDEO_LIBRARY } from "./data/videos";

const STORAGE_KEY = "tylertube_watch_progress";
const LAST_VIDEO_STORAGE_KEY = "tylertube_last_video_id";
const THEME_STORAGE_KEY = "tylertube_theme";
const SIDE_PLAYER_STORAGE_KEY = "tylertube_side_player_prefs";

function loadSavedWatchProgress() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
}

function getInitialVideoId(initialProgress) {
  try {
    const savedVideoId = localStorage.getItem(LAST_VIDEO_STORAGE_KEY);
    if (savedVideoId && VIDEO_LIBRARY.some((v) => v.id === savedVideoId)) {
      return savedVideoId;
    }
  } catch {
    // Ignore storage errors
  }

  // Fallback to the most recently watched video in watchProgress
  let latestId = "";
  let latestTime = 0;
  for (const v of VIDEO_LIBRARY) {
    const entry = initialProgress?.[v.id];
    if (entry?.updatedAt && entry.updatedAt > latestTime) {
      latestTime = entry.updatedAt;
      latestId = v.id;
    }
  }
  if (latestId) return latestId;

  return VIDEO_LIBRARY[0]?.id || "";
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY) || "light";
      document.documentElement.setAttribute("data-theme", saved);
      return saved;
    } catch {
      document.documentElement.setAttribute("data-theme", "light");
      return "light";
    }
  });
  const [watchProgress, setWatchProgress] = useState(() =>
    loadSavedWatchProgress()
  );
  const [currentVideoId, setCurrentVideoId] = useState(() =>
    getInitialVideoId(watchProgress)
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCourse, setSelectedCourse] = useState("ALL");
  const [selectedSection, setSelectedSection] = useState("ALL");
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [isSidePlayer, setIsSidePlayer] = useState(false);
  const [sidePlayerPrefs, setSidePlayerPrefs] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDE_PLAYER_STORAGE_KEY);
      return saved
        ? { width: 420, side: "right", vertical: "bottom", ...JSON.parse(saved) }
        : { width: 420, side: "right", vertical: "bottom" };
    } catch {
      return { width: 420, side: "right", vertical: "bottom" };
    }
  });
  const [filterWatchStatus, setFilterWatchStatus] = useState("ALL");

  const courses = useMemo(() => {
    const unique = new Set();
    for (const v of VIDEO_LIBRARY) {
      if (v.course) unique.add(v.course);
    }
    return Array.from(unique);
  }, []);

  const sections = useMemo(() => {
    const unique = new Set();
    for (const v of VIDEO_LIBRARY) {
      if (selectedCourse !== "ALL" && v.course !== selectedCourse) continue;
      if (v.section) unique.add(v.section);
    }
    return Array.from(unique);
  }, [selectedCourse]);

  const handleCourseChange = useCallback((course) => {
    setSelectedCourse(course);
    setSelectedSection("ALL");
  }, []);

  const filteredVideos = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return VIDEO_LIBRARY.filter((v) => {
      if (selectedCourse !== "ALL" && v.course !== selectedCourse) {
        return false;
      }
      if (selectedSection !== "ALL" && v.section !== selectedSection) {
        return false;
      }
      if (filterWatchStatus === "IN_PROGRESS") {
        const prog = watchProgress[v.id];
        if (!prog || !(prog.time > 0) || prog.completed) return false;
      } else if (filterWatchStatus === "WATCHED") {
        const prog = watchProgress[v.id];
        if (!prog || (!prog.completed && !(prog.duration > 0 && prog.time >= prog.duration - 2))) {
          return false;
        }
      }
      if (!q) return true;
      return (
        v.title.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        (v.course && v.course.toLowerCase().includes(q)) ||
        (v.section && v.section.toLowerCase().includes(q))
      );
    });
  }, [searchQuery, selectedCourse, selectedSection, filterWatchStatus, watchProgress]);

  const currentVideo = useMemo(() => {
    return (
      VIDEO_LIBRARY.find((v) => v.id === currentVideoId) || VIDEO_LIBRARY[0]
    );
  }, [currentVideoId]);

  useEffect(() => {
    if (!currentVideo?.id) return;
    try {
      localStorage.setItem(LAST_VIDEO_STORAGE_KEY, currentVideo.id);
    } catch {
      // Ignore storage errors
    }
  }, [currentVideo?.id]);

  const activePlaylist =
    filteredVideos.length > 0 ? filteredVideos : VIDEO_LIBRARY;

  const handlePrev = useCallback(() => {
    const idx = activePlaylist.findIndex((v) => v.id === currentVideo?.id);
    const prevIdx =
      idx === -1
        ? 0
        : (idx - 1 + activePlaylist.length) % activePlaylist.length;
    setCurrentVideoId(activePlaylist[prevIdx].id);
  }, [activePlaylist, currentVideo]);

  const handleNext = useCallback(() => {
    const idx = activePlaylist.findIndex((v) => v.id === currentVideo?.id);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % activePlaylist.length;
    setCurrentVideoId(activePlaylist[nextIdx].id);
  }, [activePlaylist, currentVideo]);

  const handleSelectVideo = useCallback(
    (video) => {
      setCurrentVideoId(video.id);
      if (!isSidePlayer && (isTheaterMode || window.innerWidth <= 1024)) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [isSidePlayer, isTheaterMode]
  );

  const updateSidePlayerPrefs = useCallback((updater) => {
    setSidePlayerPrefs((prev) => {
      const next =
        typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      try {
        localStorage.setItem(SIDE_PLAYER_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors
      }
      return next;
    });
  }, []);

  const toggleTheaterMode = useCallback(() => {
    setIsTheaterMode((prev) => {
      const next = !prev;
      if (next) setIsSidePlayer(false);
      return next;
    });
  }, []);

  const toggleSidePlayer = useCallback(() => {
    setIsSidePlayer((prev) => {
      const next = !prev;
      if (next) setIsTheaterMode(false);
      return next;
    });
  }, []);

  const handleTimeUpdate = useCallback((videoId, time, duration, options = {}) => {
    if (!videoId || !Number.isFinite(time) || time < 0) return;

    setWatchProgress((prev) => {
      const prevEntry = prev[videoId];
      const validDuration =
        Number.isFinite(duration) && duration > 0
          ? duration
          : prevEntry?.duration || 0;
      const isCompleted = Boolean(
        options.completed ||
          (validDuration > 0 && time >= Math.max(0, validDuration - 1.5))
      );

      const nextEntry = {
        time: Math.max(0, time),
        duration: validDuration,
        completed: isCompleted,
        updatedAt: Date.now()
      };

      const updated = {
        ...prev,
        [videoId]: nextEntry
      };

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage quota errors
      }

      // Avoid excessive React re-renders during smooth playback unless second changed or forced
      if (
        !options.force &&
        prevEntry &&
        Math.floor(prevEntry.time || 0) === Math.floor(nextEntry.time) &&
        Math.floor(prevEntry.duration || 0) === Math.floor(nextEntry.duration) &&
        Boolean(prevEntry.completed) === isCompleted
      ) {
        return prev;
      }

      return updated;
    });
  }, []);

  const handleResetProgress = useCallback((videoId) => {
    if (!videoId) return;
    setWatchProgress((prev) => {
      const prevEntry = prev[videoId];
      const updated = {
        ...prev,
        [videoId]: {
          time: 0,
          duration: prevEntry?.duration || 0,
          completed: false,
          updatedAt: Date.now()
        }
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage quota errors
      }
      return updated;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "light" ? "dark" : "light"));
  }, []);

  // Keyboard shortcuts: 'T' for Theater Mode, 'S' for Side Player when not typing in inputs
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        toggleTheaterMode();
      } else if (key === "s") {
        toggleSidePlayer();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleTheaterMode, toggleSidePlayer]);

  return (
    <>
      <Navbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isTheaterMode={isTheaterMode}
        onToggleTheater={toggleTheaterMode}
        isSidePlayer={isSidePlayer}
        onToggleSidePlayer={toggleSidePlayer}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <main
        className={`container ${isTheaterMode ? "theater-mode" : ""} ${isSidePlayer ? "side-player-active" : ""
          }`}
      >
        <VideoPlayer
          video={currentVideo}
          onEnded={handleNext}
          onPrev={handlePrev}
          onNext={handleNext}
          savedTime={watchProgress[currentVideo?.id]?.time || 0}
          savedProgress={watchProgress[currentVideo?.id]}
          onTimeUpdate={handleTimeUpdate}
          onResetProgress={handleResetProgress}
          isSidePlayer={isSidePlayer}
          onToggleSidePlayer={toggleSidePlayer}
          sidePlayerPrefs={sidePlayerPrefs}
          onUpdateSidePlayerPrefs={updateSidePlayerPrefs}
        />

        <VideoGrid
          videos={filteredVideos}
          allVideosCount={VIDEO_LIBRARY.length}
          courses={courses}
          sections={sections}
          selectedCourse={selectedCourse}
          selectedSection={selectedSection}
          filterWatchStatus={filterWatchStatus}
          onCourseChange={handleCourseChange}
          onSectionChange={setSelectedSection}
          onFilterWatchStatusChange={setFilterWatchStatus}
          currentVideoId={currentVideo?.id}
          watchProgress={watchProgress}
          onSelectVideo={handleSelectVideo}
          onResetProgress={handleResetProgress}
        />
      </main>
    </>
  );
}


