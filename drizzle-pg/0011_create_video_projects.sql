-- Migration 0011: Scene-based video project tables
-- video_projects: replaces single-shot creations for multi-scene video generation
-- video_scenes: individual scenes within a project, one per AI-generated asset

CREATE TABLE IF NOT EXISTS video_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scripting',
  total_duration INTEGER,
  scene_count INTEGER,
  script JSONB,
  final_video_url TEXT,
  thumbnail_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_scenes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES video_projects(id) ON DELETE CASCADE,
  scene_number INTEGER NOT NULL,
  duration INTEGER,
  visual_type TEXT NOT NULL DEFAULT 'motion',
  narration TEXT,
  visual_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  asset_url TEXT,
  asset_type TEXT,
  audio_url TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for user-scoped queries
CREATE INDEX idx_video_projects_user_id ON video_projects(user_id);
CREATE INDEX idx_video_projects_status ON video_projects(status);
CREATE INDEX idx_video_scenes_project_id ON video_scenes(project_id);
CREATE INDEX idx_video_scenes_status ON video_scenes(status);
CREATE INDEX idx_video_scenes_project_scene ON video_scenes(project_id, scene_number);
