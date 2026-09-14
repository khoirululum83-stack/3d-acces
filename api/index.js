const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// 1. KONEKSI DATABASE (MONGODB)
// -----------------------------------------------------------------------------
if (process.env.MONGO_URI) {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected Successfully'))
    .catch((err) => console.error('MongoDB Connection Error:', err));
}

// -----------------------------------------------------------------------------
// 2. SKEMA DATABASE (MODELS)
// -----------------------------------------------------------------------------

// Model Pengguna (Admin, Guru, Siswa)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, enum: ['admin', 'guru', 'siswa'], default: 'siswa' }
}, { timestamps: true });

// Model Ujian & 40 Soal (25 PG, 10 BS, 5 Essay)
const questionSchema = new mongoose.Schema({
  questionId: { type: Number, required: true },
  type: { type: String, enum: ['pg', 'bs', 'essay'], required: true },
  question: { type: String, required: true },
  options: [String], // Opsi untuk Pilihan Ganda
  correctAnswer: String // Kunci jawaban untuk PG dan Benar/Salah
});

const quizSchema = new mongoose.Schema({
  title: { type: String, default: 'Ujian Dasar Microsoft Access' },
  questions: [questionSchema]
}, { timestamps: true });

// Model Hasil Ujian & Penilaian
const resultSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentName: { type: String, required: true },
  scorePG_BS: { type: Number, default: 0 },
  answers: [{
    questionId: Number,
    type: { type: String, enum: ['pg', 'bs', 'essay'] },
    studentAnswer: String
  }],
  essayScores: [{
    questionId: Number,
    score: Number
  }],
  finalScore: { type: Number, default: 0 },
  status: { type: String, enum: ['Pending', 'Graded'], default: 'Pending' }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Quiz = mongoose.models.Quiz || mongoose.model('Quiz', quizSchema);
const Result = mongoose.models.Result || mongoose.model('Result', resultSchema);

// -----------------------------------------------------------------------------
// 3. ENDPOINTS API
// -----------------------------------------------------------------------------

// Check Health Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running', timestamp: new Date() });
});

// A. ROUTE AUTHENTICATION & ADMIN
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, name, role } = req.body;
    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: 'Username sudah digunakan' });

    const user = new User({ username, password, name, role: role || 'siswa' });
    await user.save();
    res.status(201).json({ message: 'User berhasil dibuat', user: { id: user._id, username: user.username, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'Username atau password salah' });

    res.json({ message: 'Login berhasil', user: { id: user._id, name: user.name, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B. ROUTE SOAL UJAN (SISWA & ADMIN)
app.get('/api/quiz', async (req, res) => {
  try {
    const quiz = await Quiz.findOne();
    if (!quiz) return res.status(404).json({ error: 'Soal belum diunggah oleh guru/admin' });
    res.json(quiz);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Seed / Save 40 Soal (Khusus Admin/Guru)
app.post('/api/admin/quiz', async (req, res) => {
  try {
    const { title, questions } = req.body;
    await Quiz.deleteMany({}); // Reset soal lama
    const newQuiz = new Quiz({ title, questions });
    await newQuiz.save();
    res.status(201).json({ message: '40 Soal berhasil disimpan!', quiz: newQuiz });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// C. ROUTE PENGERJAAN UJIAN (SISWA)
app.post('/api/siswa/submit-quiz', async (req, res) => {
  const { studentId, studentName, answers } = req.body;

  if (!studentName || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Data jawaban tidak valid' });
  }

  try {
    const quiz = await Quiz.findOne();
    let scorePG_BS = 0;

    // Kalkulasi Otomatis Skor PG (25) & BS (10)
    if (quiz && quiz.questions) {
      answers.forEach(ans => {
        const q = quiz.questions.find(item => item.questionId === ans.questionId);
        if (q && (q.type === 'pg' || q.type === 'bs')) {
          if (q.correctAnswer && q.correctAnswer.trim().toLowerCase() === String(ans.studentAnswer).trim().toLowerCase()) {
            scorePG_BS += 2; // Nilai 2 poin per soal PG & BS (Total max: 70)
          }
        }
      });
    }

    const newResult = new Result({
      studentId: studentId || null,
      studentName,
      answers,
      scorePG_BS,
      finalScore: scorePG_BS,
      status: 'Pending'
    });

    await newResult.save();
    res.json({ message: 'Ujian berhasil dikirim!', resultId: newResult._id, scorePG_BS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// D. ROUTE PENILAIAN & REKAP (GURU)
app.get('/api/guru/results', async (req, res) => {
  try {
    const results = await Result.find().sort({ createdAt: -1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Input Nilai Essay oleh Guru (5 Soal Essay)
app.post('/api/guru/grade-essay', async (req, res) => {
  const { resultId, essayScores } = req.body; 

  if (!resultId || !Array.isArray(essayScores)) {
    return res.status(400).json({ error: 'resultId dan array essayScores wajib diisi.' });
  }

  try {
    const result = await Result.findById(resultId);
    if (!result) {
      return res.status(404).json({ error: 'Data hasil ujian tidak ditemukan.' });
    }

    // Hitung total nilai essay
    const totalEssayScore = essayScores.reduce((acc, item) => acc + (Number(item.score) || 0), 0);

    result.essayScores = essayScores;
    result.finalScore = (result.scorePG_BS || 0) + totalEssayScore;
    result.status = 'Graded';

    await result.save();

    return res.json({ 
      message: 'Penilaian essay berhasil disimpan!', 
      result 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// Export Serverless Handler Vercel
module.exports = app;
