import React, { useState, useEffect, useMemo, useCallback } from "react";
import Navbar from "./components/Navbar";
import VideoPlayer from "./components/VideoPlayer";
import VideoGrid from "./components/VideoGrid";
import { VIDEO_LIBRARY } from "./data/videos";

const STORAGE_KEY = "tylertube_watch_progress";
const THEME_STORAGE_KEY = "tylertube_theme";

export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) || "light";
    } catch {
      return "light";
    }
  });
  const [currentVideoId, setCurrentVideoId] = useState(
    () => VIDEO_LIBRARY[0]?.id || ""
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCourse, setSelectedCourse] = useState("ALL");
  const [selectedSection, setSelectedSection] = useState("ALL");
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [watchProgress, setWatchProgress] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

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
      if (!q) return true;
      return (
        v.title.toLowerCase().includes(q) ||
        v.description.toLowerCase().includes(q) ||
        (v.course && v.course.toLowerCase().includes(q)) ||
        (v.section && v.section.toLowerCase().includes(q))
      );
    });
  }, [searchQuery, selectedCourse, selectedSection]);

  const currentVideo = useMemo(() => {
    return (
      VIDEO_LIBRARY.find((v) => v.id === currentVideoId) || VIDEO_LIBRARY[0]
    );
  }, [currentVideoId]);

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

  const handleSelectVideo = useCallback((video) => {
    setCurrentVideoId(video.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleTimeUpdate = useCallback((videoId, time, duration) => {
    setWatchProgress((prev) => {
      const updated = {
        ...prev,
        [videoId]: { time, duration, updatedAt: Date.now() }
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

  // Keyboard shortcut 'T' for Theater Mode when not typing in inputs
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key.toLowerCase() === "t") {
        setIsTheaterMode((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <>
      <Navbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        isTheaterMode={isTheaterMode}
        onToggleTheater={() => setIsTheaterMode((prev) => !prev)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <main className={`container ${isTheaterMode ? "theater-mode" : ""}`}>
        <VideoPlayer
          video={currentVideo}
          onEnded={handleNext}
          onPrev={handlePrev}
          onNext={handleNext}
          savedTime={watchProgress[currentVideo?.id]?.time || 0}
          onTimeUpdate={handleTimeUpdate}
        />

        <VideoGrid
          videos={filteredVideos}
          courses={courses}
          sections={sections}
          selectedCourse={selectedCourse}
          selectedSection={selectedSection}
          onCourseChange={handleCourseChange}
          onSectionChange={setSelectedSection}
          currentVideoId={currentVideo?.id}
          watchProgress={watchProgress}
          onSelectVideo={handleSelectVideo}
        />
      </main>
    </>
  );
}


