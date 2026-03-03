import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { Github, Mail } from 'lucide-react';

export default function Register() {
    const [email, setEmail] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const { register, isLoading } = useAuthStore();
    const navigate = useNavigate();

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        try {
            await register(email, username, password);
            navigate('/');
        } catch (err: any) {
            setError(err.response?.data?.error || 'Registration failed');
        }
    };

    return (
        <div className="auth-page">
            <div className="auth-card glass">
                <h1 className="gradient-text">Create account</h1>
                <p>Get started with Runnable</p>

                {error && <div className="alert alert-error">{error}</div>}

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label>Email</label>
                        <input type="email" className="form-input" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
                    </div>
                    <div className="form-group">
                        <label>Username</label>
                        <input type="text" className="form-input" placeholder="johndoe" value={username} onChange={(e) => setUsername(e.target.value)} required />
                    </div>
                    <div className="form-group">
                        <label>Password</label>
                        <input type="password" className="form-input" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
                    </div>
                    <button type="submit" className="btn btn-primary btn-full" disabled={isLoading}>
                        {isLoading ? <span className="spinner" /> : 'Create Account'}
                    </button>
                </form>

                <div className="oauth-divider">or continue with</div>
                <div className="oauth-buttons">
                    <a href="/api/auth/github" className="btn btn-secondary"><Github size={18} /> GitHub</a>
                    <a href="/api/auth/google" className="btn btn-secondary"><Mail size={18} /> Google</a>
                </div>

                <p style={{ textAlign: 'center', marginTop: 24, fontSize: 14 }}>
                    Already have an account? <Link to="/login" style={{ color: 'var(--accent)' }}>Sign in</Link>
                </p>
            </div>
        </div>
    );
}
