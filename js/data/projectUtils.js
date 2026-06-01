/**
 * projectUtils.js — Shared project helper functions
 *
 * Extracted to break the circular dependency between ProjectManager.js and
 * Repository.js.  Both modules need getProjectFolderName() but used to import
 * from each other, creating a cycle that can cause undefined bindings during
 * ES module evaluation.
 *
 * Pattern: Module Pattern
 */

/**
 * Derive a safe, stable filesystem folder name for a project.
 *
 * Format : `SanitizedName_shortId`
 * Example: "My Survey 2024" with id "a1b2c3…" → "My_Survey_2024_a1b2c3"
 *
 * Rules
 * -----
 * - Non-alphanumeric chars become underscores.
 * - Consecutive underscores are collapsed to one.
 * - Leading/trailing underscores are trimmed.
 * - If the sanitised name is empty the placeholder "Project" is used.
 * - The short id (first 6 chars of the UUID) is appended so two projects
 *   that happen to have identical names still get distinct folder names.
 *
 * IMPORTANT — this value must never change after project creation because
 * every stored file path is derived from it.  Renaming a project only changes
 * project.name, never this value.
 *
 * @param {object|null} project  Project object from masterData.projects.
 * @returns {string}
 */
export function getProjectFolderName(project) {
    if (!project) return 'Unassigned';

    const safeName = project.name
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g,      '_')
        .replace(/^_|_$/g,      '');

    const shortId = project.id.substring(0, 6);
    return `${safeName || 'Project'}_${shortId}`;
}
