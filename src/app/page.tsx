export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-950 via-purple-950 to-gray-950 flex items-center justify-center p-8">
      <div className="max-w-2xl text-center space-y-8">
        <div className="space-y-4">
          <h1 className="text-5xl font-bold bg-gradient-to-r from-purple-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">
            LIE
          </h1>
          <p className="text-xl text-gray-400">LinkedIn Intelligence Engine</p>
        </div>

        <div className="bg-gray-900/50 border border-purple-500/20 rounded-2xl p-8 space-y-4 backdrop-blur-sm">
          <div className="flex items-center justify-center gap-3">
            <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 font-medium">System Active</span>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-gray-800/50 rounded-xl p-4">
              <p className="text-gray-500">Intelligence Cycles</p>
              <p className="text-2xl font-bold text-white">2x/day</p>
            </div>
            <div className="bg-gray-800/50 rounded-xl p-4">
              <p className="text-gray-500">Content Generation</p>
              <p className="text-2xl font-bold text-white">Daily</p>
            </div>
            <div className="bg-gray-800/50 rounded-xl p-4">
              <p className="text-gray-500">Brain Model</p>
              <p className="text-lg font-semibold text-purple-400">Claude Sonnet 4</p>
            </div>
            <div className="bg-gray-800/50 rounded-xl p-4">
              <p className="text-gray-500">Delivery</p>
              <p className="text-lg font-semibold text-indigo-400">Discord</p>
            </div>
          </div>
        </div>

        <p className="text-gray-600 text-sm">
          Powered by Rocket Code &bull; OpenRouter &bull; Neon
        </p>
      </div>
    </main>
  );
}
