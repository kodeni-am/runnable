import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { php } from '@codemirror/lang-php';
import { java } from '@codemirror/lang-java';
import { oneDark } from '@codemirror/theme-one-dark';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { projectsApi } from '../api/projects';
import { Save, X, FileText, AlertCircle, Check, FilePlus } from 'lucide-react';

function getLanguageExtension(filename: string) {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
        case 'js': case 'jsx': case 'mjs': case 'cjs':
            return javascript();
        case 'ts': case 'tsx': case 'mts':
            return javascript({ typescript: true, jsx: ext.includes('x') });
        case 'html': case 'htm': case 'svelte': case 'vue':
            return html();
        case 'css': case 'scss': case 'less':
            return css();
        case 'json': case 'jsonc':
            return json();
        case 'py': case 'pyw':
            return python();
        case 'md': case 'mdx':
            return markdown();
        case 'xml': case 'svg': case 'xsl':
            return xml();
        case 'php':
            return php();
        case 'java': case 'kt': case 'kts':
            return java();
        default:
            return [];
    }
}

interface CodeEditorProps {
    projectId: string;
    filePath: string | null;
    onClose: () => void;
    onSaved?: () => void;
    isNewFile?: boolean;
    currentDir?: string;
    readOnly?: boolean;
}

export default function CodeEditor({ projectId, filePath, onClose, onSaved, isNewFile, currentDir, readOnly }: CodeEditorProps) {
    const editorRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const [modified, setModified] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    // Store content to initialize the editor after DOM is ready
    const pendingContentRef = useRef<string | null>(null);
    const saveRef = useRef<() => void>(() => { });
    // Language extension lives in a compartment so it can be reconfigured
    // when the filename of a new file changes.
    const languageCompartmentRef = useRef(new Compartment());

    // Keep saveRef always pointing to latest handleSave
    const handleSave = async () => {
        if (!viewRef.current) return;
        // Read actualPath from the component's current render via closure
        const path = isNewFile
            ? (currentDir ? `${currentDir}/${newFileName}` : newFileName)
            : filePath;

        if (!path) {
            setError('Enter a filename first');
            return;
        }

        setSaving(true);
        setError('');
        try {
            const content = viewRef.current.state.doc.toString();
            if (isNewFile) {
                await projectsApi.createFile(projectId, path, content);
            } else {
                await projectsApi.writeFile(projectId, path, content);
            }
            setModified(false);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
            onSaved?.();
        } catch (err: any) {
            setError(err.response?.data?.error || 'Failed to save');
        }
        setSaving(false);
    };

    // Update the ref on every render so CodeMirror's keymap always calls the latest version
    saveRef.current = handleSave;

    const initEditor = (content: string) => {
        if (!editorRef.current) return;

        // Destroy existing editor
        if (viewRef.current) {
            viewRef.current.destroy();
            viewRef.current = null;
        }

        const filename = isNewFile ? (newFileName || 'untitled.txt') : (filePath || '');

        const state = EditorState.create({
            doc: content,
            extensions: [
                lineNumbers(),
                highlightActiveLine(),
                highlightActiveLineGutter(),
                drawSelection(),
                bracketMatching(),
                indentOnInput(),
                history(),
                highlightSelectionMatches(),
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                oneDark,
                languageCompartmentRef.current.of(getLanguageExtension(filename)),
                ...(readOnly ? [EditorState.readOnly.of(true)] : []),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...searchKeymap,
                    indentWithTab,
                    // Use ref so we always call the latest handleSave
                    { key: 'Mod-s', run: () => { saveRef.current(); return true; } },
                ]),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) {
                        setModified(true);
                        setSaved(false);
                    }
                }),
                EditorView.theme({
                    '&': {
                        height: '100%',
                        fontSize: '13.5px',
                    },
                    '.cm-scroller': {
                        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', monospace",
                        lineHeight: '1.6',
                    },
                    '.cm-gutters': {
                        borderRight: '1px solid rgba(255,255,255,0.06)',
                    },
                }),
            ],
        });

        const view = new EditorView({
            state,
            parent: editorRef.current,
        });

        viewRef.current = view;
        // Focus the editor so user can start typing
        view.focus();
    };

    // Load file content
    useEffect(() => {
        let cancelled = false;

        const doLoad = async () => {
            if (isNewFile || !filePath) {
                pendingContentRef.current = '';
                setLoading(false);
                return;
            }

            setLoading(true);
            setError('');
            try {
                const { data } = await projectsApi.readFile(projectId, filePath);
                if (!cancelled) {
                    pendingContentRef.current = data.content;
                    setLoading(false);
                }
            } catch (err: any) {
                if (!cancelled) {
                    setError(err.response?.data?.error || 'Failed to load file');
                    setLoading(false);
                }
            }
        };

        doLoad();
        return () => { cancelled = true; };
    }, [projectId, filePath, isNewFile]);

    // Initialize editor AFTER the DOM ref is available (loading is false)
    useEffect(() => {
        if (!loading && pendingContentRef.current !== null && editorRef.current) {
            initEditor(pendingContentRef.current);
            pendingContentRef.current = null;
        }
    }, [loading]);

    // For new files, the language is picked from newFileName at mount when
    // it's still empty — reconfigure it as the user types a filename.
    useEffect(() => {
        if (!isNewFile || !viewRef.current) return;
        viewRef.current.dispatch({
            effects: languageCompartmentRef.current.reconfigure(
                getLanguageExtension(newFileName || 'untitled.txt')
            ),
        });
    }, [isNewFile, newFileName]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (viewRef.current) {
                viewRef.current.destroy();
                viewRef.current = null;
            }
        };
    }, []);

    const fileName = filePath ? filePath.split('/').pop() : 'New File';

    return (
        <div className="code-editor-container glass">
            {/* Header */}
            <div className="code-editor-header">
                <div className="code-editor-title">
                    {isNewFile ? <FilePlus size={16} /> : <FileText size={16} />}
                    {isNewFile ? (
                        <input
                            className="code-editor-filename-input"
                            placeholder="filename.ext"
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            autoFocus
                        />
                    ) : (
                        <span>{fileName}</span>
                    )}
                    {modified && <span className="code-editor-modified">●</span>}
                    {filePath && (
                        <span className="code-editor-path">/{filePath}</span>
                    )}
                </div>
                <div className="code-editor-actions">
                    {error && (
                        <span className="code-editor-error">
                            <AlertCircle size={14} /> {error}
                        </span>
                    )}
                    {saved && (
                        <span className="code-editor-saved">
                            <Check size={14} /> Saved
                        </span>
                    )}
                    <button
                        className="btn btn-primary"
                        onClick={handleSave}
                        disabled={saving || readOnly || (!modified && !isNewFile) || (isNewFile && !newFileName.trim())}
                        style={{ padding: '6px 16px', fontSize: 13, gap: 6, ...(readOnly ? { display: 'none' } : {}) }}
                    >
                        <Save size={14} />
                        {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button className="btn-icon" onClick={onClose} title="Close editor" style={{ marginLeft: 4 }}>
                        <X size={18} />
                    </button>
                </div>
            </div>

            {/* Editor area */}
            {loading ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
                    <div className="spinner" />
                </div>
            ) : error && !viewRef.current ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, color: 'var(--status-error)' }}>
                    <AlertCircle size={20} style={{ marginRight: 8 }} /> {error}
                </div>
            ) : (
                <div ref={editorRef} className="code-editor-body" />
            )}
        </div>
    );
}
