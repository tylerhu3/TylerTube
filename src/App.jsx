import React, { useState, useEffect, useMemo, useCallback } from "react";
import Navbar from "./components/Navbar";
import SideMenu from "./components/SideMenu";
import VideoPlayer from "./components/VideoPlayer";
import VideoGrid from "./components/VideoGrid";
import HistoryPage from "./components/HistoryPage";
import FavoritesPage from "./components/FavoritesPage";
import { VIDEO_LIBRARY } from "./data/videos";

const STORAGE_KEY = "tylertube_watch_progress";
const FAVORITES_STORAGE_KEY = "tylertube_favorites";
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

function loadSavedFavorites() {
  try {
    const saved = localStorage.getItem(FAVORITES_STORAGE_KEY);
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
  const [favorites, setFavorites] = useState(() => loadSavedFavorites());
  const [currentVideoId, setCurrentVideoId] = useState(() =>
    getInitialVideoId(watchProgress)
  );
  const [currentPage, setCurrentPage] = useState("home");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
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

  const historyItems = useMemo(() => {
    const items = [];
    for (const v of VIDEO_LIBRARY) {
      const prog = watchProgress[v.id];
      if (
        prog &&
        !prog.hiddenFromHistory &&
        (prog.time > 0 || prog.completed || prog.watched)
      ) {
        items.push({ video: v, progress: prog });
      }
    }
    items.sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0));
    return items;
  }, [watchProgress]);

  const favoriteItems = useMemo(() => {
    const items = [];
    for (const v of VIDEO_LIBRARY) {
      const favEntry = favorites[v.id];
      if (favEntry) {
        items.push({
          video: v,
          addedAt: typeof favEntry === "object" ? favEntry.addedAt : Number(favEntry) || 0
        });
      }
    }
    items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return items;
  }, [favorites]);

  const { inProgressCount, completedCount } = useMemo(() => {
    let inProg = 0;
    let comp = 0;
    for (const { progress } of historyItems) {
      const isDone = Boolean(
        progress?.completed ||
          (progress?.duration > 0 && progress?.time >= progress.duration - 1.5)
      );
      if (isDone) comp++;
      else inProg++;
    }
    return { inProgressCount: inProg, completedCount: comp };
  }, [historyItems]);

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
      if (currentPage !== "home" && !isSidePlayer) {
        setCurrentPage("home");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (!isSidePlayer && (isTheaterMode || window.innerWidth <= 1024)) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [currentPage, isSidePlayer, isTheaterMode]
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

      const isGenuineWatch =
        !options.metadataOnly ||
        time > 0 ||
        isCompleted ||
        Boolean(options.played);

      const nextEntry = {
        time: Math.max(0, time),
        duration: validDuration,
        completed: isCompleted,
        watched: isGenuineWatch ? true : Boolean(prevEntry?.watched),
        hiddenFromHistory: isGenuineWatch
          ? false
          : Boolean(prevEntry?.hiddenFromHistory),
        updatedAt: isGenuineWatch ? Date.now() : prevEntry?.updatedAt || 0
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
        Boolean(prevEntry.completed) === isCompleted &&
        Boolean(prevEntry.watched) === nextEntry.watched &&
        Boolean(prevEntry.hiddenFromHistory) === nextEntry.hiddenFromHistory
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
          watched: true,
          hiddenFromHistory: false,
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

  const handleRemoveFromHistory = useCallback((videoId) => {
    if (!videoId) return;
    setWatchProgress((prev) => {
      const prevEntry = prev[videoId];
      const updated = {
        ...prev,
        [videoId]: {
          time: 0,
          duration: prevEntry?.duration || 0,
          completed: false,
          watched: false,
          hiddenFromHistory: true,
          updatedAt: 0
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

  const handleClearHistory = useCallback(() => {
    setWatchProgress((prev) => {
      const updated = {};
      for (const [id, entry] of Object.entries(prev)) {
        if (entry?.duration > 0) {
          updated[id] = {
            time: 0,
            duration: entry.duration,
            completed: false,
            watched: false,
            hiddenFromHistory: true,
            updatedAt: 0
          };
        }
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage errors
      }
      return updated;
    });
  }, []);

  const handleToggleFavorite = useCallback((videoId) => {
    if (!videoId) return;
    setFavorites((prev) => {
      const next = { ...prev };
      if (next[videoId]) {
        delete next[videoId];
      } else {
        next[videoId] = { addedAt: Date.now() };
      }
      try {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }, []);

  const handleClearFavorites = useCallback(() => {
    setFavorites({});
    try {
      localStorage.removeItem(FAVORITES_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
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
      if (key === "t" && currentPage === "home") {
        toggleTheaterMode();
      } else if (key === "s") {
        toggleSidePlayer();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleTheaterMode, toggleSidePlayer, currentPage]);

  const isPlayerHidden = currentPage !== "home" && !isSidePlayer;

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
        onToggleMenu={() => setIsMenuOpen((prev) => !prev)}
        currentPage={currentPage}
        onNavigate={setCurrentPage}
      />

      <SideMenu
        isOpen={isMenuOpen}
        onClose={() => setIsMenuOpen(false)}
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        totalVideosCount={VIDEO_LIBRARY.length}
        historyCount={historyItems.length}
        favoritesCount={favoriteItems.length}
        inProgressCount={inProgressCount}
        completedCount={completedCount}
      />

      <main
        className={`container ${
          currentPage !== "home"
            ? "subpage-mode"
            : `${isTheaterMode ? "theater-mode" : ""} ${
                isSidePlayer ? "side-player-active" : ""
              }`
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
          isFavorited={Boolean(favorites[currentVideo?.id])}
          onToggleFavorite={handleToggleFavorite}
          isHidden={isPlayerHidden}
          isSidePlayer={isSidePlayer}
          onToggleSidePlayer={toggleSidePlayer}
          sidePlayerPrefs={sidePlayerPrefs}
          onUpdateSidePlayerPrefs={updateSidePlayerPrefs}
        />

        {currentPage === "home" && (
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
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onSelectVideo={handleSelectVideo}
            onResetProgress={handleResetProgress}
          />
        )}

        {currentPage === "history" && (
          <HistoryPage
            historyItems={historyItems}
            watchProgress={watchProgress}
            favorites={favorites}
            currentVideoId={currentVideo?.id}
            onSelectVideo={handleSelectVideo}
            onToggleFavorite={handleToggleFavorite}
            onRemoveFromHistory={handleRemoveFromHistory}
            onClearHistory={handleClearHistory}
            onNavigateHome={() => setCurrentPage("home")}
          />
        )}

        {currentPage === "favorites" && (
          <FavoritesPage
            favoriteItems={favoriteItems}
            watchProgress={watchProgress}
            currentVideoId={currentVideo?.id}
            onSelectVideo={handleSelectVideo}
            onToggleFavorite={handleToggleFavorite}
            onClearFavorites={handleClearFavorites}
            onNavigateHome={() => setCurrentPage("home")}
          />
        )}
      </main>
    </>
  );
}
