export function getProjectFolderName(project) {
    if (!project) return 'Unassigned';

    const safeName = project.name
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_{2,}/g,      '_')
        .replace(/^_|_$/g,      '');

    const shortId = project.id.substring(0, 6);
    return `${safeName || 'Project'}_${shortId}`;
}
