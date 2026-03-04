import { useState, useEffect, useRef, type DragEvent } from 'react';
import { projectsApi } from '../api/projects';
import { Folder, FileText, Download, Trash2, Upload, ChevronRight, Home, FolderPlus, FilePlus, Pencil, X } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import CodeEditor from './CodeEditor';

interface FileInfo {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    modifiedAt: string;
}

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const TEXT_EXTENSIONS = new Set([
    'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts',
    'html', 'htm', 'css', 'scss', 'less', 'sass',
    'json', 'jsonc', 'json5',
    'md', 'mdx', 'txt', 'log', 'csv',
    'py', 'pyw', 'rb', 'rs', 'go', 'java', 'kt', 'kts',
    'c', 'cpp', 'h', 'hpp', 'cs', 'swift',
    'xml', 'svg', 'xsl', 'yaml', 'yml', 'toml', 'ini', 'cfg',
    'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1',
    'sql', 'graphql', 'gql',
    'php', 'vue', 'svelte',
    'dockerfile', 'env', 'gitignore', 'editorconfig',
    'lock', 'conf', 'nginx', 'caddyfile',
]);

function isTextFile(filename: string): boolean {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const basename = filename.toLowerCase();
    return TEXT_EXTENSIONS.has(ext)
        || basename === 'dockerfile'
        || basename === '.gitignore'
        || basename === '.env'
        || basename === '.editorconfig'
        || basename === 'makefile'
        || basename === 'caddyfile';
}

export default function FileBrowser({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) {
    const { currentProject } = useProjectStore();
    const [files, setFiles] = useState<FileInfo[]>([]);
    const [currentPath, setCurrentPath] = useState('');
    const [loading, setLoading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [selectedFile, setSelectedFile] = useState<FileInfo | null>(null);
    const [editingFile, setEditingFile] = useState<string | null>(null);
    const [creatingNewFile, setCreatingNewFile] = useState(false);
    const [showNewFolderModal, setShowNewFolderModal] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    const loadFiles = async (path: string = '') => {
        setLoading(true);
        try {
            const { data } = await projectsApi.listFiles(projectId, path);
            setFiles(data);
            setCurrentPath(path);
        } catch {
            setFiles([]);
        }
        setLoading(false);
    };

    useEffect(() => {
        loadFiles();
    }, [projectId]);

    const handleNavigate = (file: FileInfo) => {
        if (file.isDirectory) {
            loadFiles(file.path);
        } else {
            setSelectedFile(file);
        }
    };

    const handleEdit = (e: React.MouseEvent, file: FileInfo) => {
        e.stopPropagation();
        setEditingFile(file.path);
        setCreatingNewFile(false);
        setSelectedFile(file);
    };

    const navigateToPath = (path: string) => {
        loadFiles(path);
    };

    const pathParts = currentPath ? currentPath.split('/') : [];

    const handleDownload = async (e: React.MouseEvent, file: FileInfo) => {
        e.stopPropagation();
        try {
            const { data } = await projectsApi.downloadFile(projectId, file.path);
            const url = window.URL.createObjectURL(new Blob([data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = file.name;
            link.click();
            window.URL.revokeObjectURL(url);
        } catch { }
    };

    const handleDelete = async (e: React.MouseEvent, file: FileInfo) => {
        e.stopPropagation();
        if (!confirm(`Delete ${file.name}?`)) return;
        try {
            await projectsApi.deleteFile(projectId, file.path);
            loadFiles(currentPath);
            if (editingFile === file.path) {
                setEditingFile(null);
            }
        } catch { }
    };

    const handleUpload = async (fileList: FileList) => {
        const formData = new FormData();
        formData.append('path', currentPath);
        Array.from(fileList).forEach((f) => formData.append('files', f));

        try {
            await projectsApi.uploadFiles(projectId, formData);
            loadFiles(currentPath);
        } catch { }
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) {
            handleUpload(e.dataTransfer.files);
        }
    };

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;

        const targetPath = currentPath ? `${currentPath}/${newFolderName.trim()}` : newFolderName.trim();
        try {
            await projectsApi.createDir(projectId, targetPath);
            loadFiles(currentPath);
            setShowNewFolderModal(false);
            setNewFolderName('');
        } catch (err: any) {
            alert(err.response?.data?.error || 'Failed to create folder');
        }
    };

    const handleNewFile = () => {
        setCreatingNewFile(true);
        setEditingFile(null);
        setSelectedFile(null);
    };

    const getFileUrl = (file: FileInfo) => {
        if (!currentProject) return '';
        return `http://${currentProject.subdomain}.${import.meta.env.VITE_BASE_DOMAIN || 'localhost:5175'}/${file.path}`;
    };

    const showEditor = editingFile || creatingNewFile;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {/* Editor view (full width when active) */}
            {showEditor && (
                <CodeEditor
                    projectId={projectId}
                    filePath={editingFile}
                    isNewFile={creatingNewFile}
                    currentDir={currentPath}
                    readOnly={readOnly}
                    onClose={() => {
                        setEditingFile(null);
                        setCreatingNewFile(false);
                    }}
                    onSaved={() => loadFiles(currentPath)}
                />
            )}

            <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="file-browser glass">
                        <div className="file-browser-header">
                            <div className="file-path">
                                <span className="file-path-part" onClick={() => navigateToPath('')}>
                                    <Home size={14} />
                                </span>
                                {pathParts.map((part, i) => (
                                    <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
                                        <span
                                            className="file-path-part"
                                            onClick={() => navigateToPath(pathParts.slice(0, i + 1).join('/'))}
                                        >
                                            {part}
                                        </span>
                                    </span>
                                ))}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                {!readOnly && (
                                    <>
                                        <button className="btn btn-secondary" onClick={handleNewFile} style={{ fontSize: 13, padding: '6px 14px' }}>
                                            <FilePlus size={14} /> New File
                                        </button>
                                        <button className="btn btn-secondary" onClick={() => setShowNewFolderModal(true)} style={{ fontSize: 13, padding: '6px 14px' }}>
                                            <FolderPlus size={14} /> New Folder
                                        </button>
                                        <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()} style={{ fontSize: 13, padding: '6px 14px' }}>
                                            <Upload size={14} /> Upload
                                        </button>
                                    </>
                                )}
                            </div>
                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                style={{ display: 'none' }}
                                onChange={(e) => e.target.files && handleUpload(e.target.files)}
                            />
                        </div>

                        {loading ? (
                            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                                <div className="spinner" />
                            </div>
                        ) : files.length === 0 ? (
                            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                                Empty directory
                            </div>
                        ) : (
                            <ul className="file-list">
                                {files.map((file) => (
                                    <li
                                        key={file.path}
                                        className={`file-item ${editingFile === file.path ? 'file-item-active' : selectedFile?.path === file.path ? 'file-item-selected' : ''}`}
                                        onClick={() => handleNavigate(file)}
                                    >
                                        <span className="file-icon">
                                            {file.isDirectory ? <Folder size={18} /> : <FileText size={18} />}
                                        </span>
                                        <span className="file-name">{file.name}</span>
                                        {!file.isDirectory && <span className="file-size">{formatSize(file.size)}</span>}
                                        <span className="file-date">{new Date(file.modifiedAt).toLocaleDateString()}</span>
                                        <div className="file-actions">
                                            {!file.isDirectory && isTextFile(file.name) && (
                                                <button className="btn-icon" onClick={(e) => handleEdit(e, file)} title={readOnly ? 'View' : 'Edit'} style={{ color: 'var(--accent)' }}>
                                                    <Pencil size={16} />
                                                </button>
                                            )}
                                            {!file.isDirectory && (
                                                <button className="btn-icon" onClick={(e) => handleDownload(e, file)} title="Download">
                                                    <Download size={16} />
                                                </button>
                                            )}
                                            {!readOnly && (
                                                <button className="btn-icon" onClick={(e) => handleDelete(e, file)} title="Delete" style={{ color: 'var(--status-error)' }}>
                                                    <Trash2 size={16} />
                                                </button>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div
                        className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
                        onDragOver={(e) => { if (!readOnly) { e.preventDefault(); setDragOver(true); } }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={readOnly ? undefined : handleDrop}
                        onClick={readOnly ? undefined : () => fileInputRef.current?.click()}
                        style={readOnly ? { display: 'none' } : {}}
                    >
                        <Upload size={32} style={{ color: 'var(--text-muted)', marginBottom: 12 }} />
                        <p style={{ color: 'var(--text-secondary)' }}>Drag & drop files here or click to upload</p>
                    </div>
                </div>

                {selectedFile && (
                    <div className="file-details-panel glass" style={{ width: 360, flexShrink: 0, borderRadius: 'var(--radius-md)', padding: 24, position: 'sticky', top: 24, height: 'fit-content', animation: 'fadeIn 0.2s ease', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' }}>
                            <h2 style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, fontSize: 18, fontWeight: 700 }}>
                                <FileText size={18} /> File Details
                            </h2>
                            <button className="btn-icon" onClick={() => setSelectedFile(null)} style={{ margin: '-8px' }}>
                                <X size={18} />
                            </button>
                        </div>

                        <div className="info-grid" style={{ gridTemplateColumns: '1fr', gap: 12, marginBottom: 0 }}>
                            <div className="info-card glass" style={{ padding: 16 }}>
                                <div className="info-card-label">Name</div>
                                <div className="info-card-value" style={{ wordBreak: 'break-all', fontSize: 14 }}>{selectedFile.name}</div>
                            </div>
                            <div className="info-card glass" style={{ padding: 16 }}>
                                <div className="info-card-label">Path</div>
                                <div className="info-card-value" style={{ wordBreak: 'break-all', fontSize: 13 }}>/{selectedFile.path}</div>
                            </div>
                            <div className="info-card glass" style={{ padding: 16, display: 'flex', gap: 16 }}>
                                <div style={{ flex: 1 }}>
                                    <div className="info-card-label">Size</div>
                                    <div className="info-card-value" style={{ fontSize: 14 }}>{formatSize(selectedFile.size)}</div>
                                </div>
                                <div style={{ flex: 1 }}>
                                    <div className="info-card-label">Modified</div>
                                    <div className="info-card-value" style={{ fontSize: 12 }}>{new Date(selectedFile.modifiedAt).toLocaleString()}</div>
                                </div>
                            </div>
                            {currentProject && currentProject.serverType === 'static' && (
                                <div className="info-card glass" style={{ padding: 16 }}>
                                    <div className="info-card-label">Public URL</div>
                                    <div className="info-card-value" style={{ wordBreak: 'break-all', fontSize: 13 }}>
                                        <a href={getFileUrl(selectedFile)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                                            {getFileUrl(selectedFile)}
                                        </a>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
                            {isTextFile(selectedFile.name) && (
                                <button className="btn btn-primary" style={{ flex: 1, padding: '10px', fontSize: 13 }} onClick={() => {
                                    setEditingFile(selectedFile.path);
                                    setCreatingNewFile(false);
                                }}>
                                    <Pencil size={16} /> {readOnly ? 'View' : 'Edit'}
                                </button>
                            )}
                            <button className="btn btn-secondary" style={{ flex: 1, padding: '10px', fontSize: 13 }} onClick={() => handleDownload(new MouseEvent('click') as any, selectedFile)}>
                                <Download size={16} /> Download
                            </button>
                            {!readOnly && (
                                <button className="btn btn-danger" style={{ flex: 1, padding: '10px', fontSize: 13 }} onClick={() => {
                                    handleDelete(new MouseEvent('click') as any, selectedFile);
                                    setSelectedFile(null);
                                }}>
                                    <Trash2 size={16} /> Delete
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {showNewFolderModal && (
                <div className="modal-overlay" onClick={() => setShowNewFolderModal(false)}>
                    <div className="modal glass" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
                        <h2>Create New Folder</h2>
                        <div className="form-group" style={{ marginTop: 16 }}>
                            <label>Folder Name</label>
                            <input
                                className="form-input"
                                placeholder="my_folder"
                                value={newFolderName}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleCreateFolder();
                                }}
                            />
                        </div>
                        <div className="modal-actions" style={{ marginTop: 24 }}>
                            <button className="btn btn-secondary" onClick={() => setShowNewFolderModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>Create</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
