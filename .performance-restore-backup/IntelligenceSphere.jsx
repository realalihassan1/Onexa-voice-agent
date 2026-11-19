import { useEffect, useRef } from 'react'

const vertexShader = `
attribute vec3 aPosition;
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform mat4 uProjection;
uniform vec3 uRotation;
uniform float uDepth;
uniform float uEnergy;
uniform float uPixelRatio;
uniform vec3 uOrbitRotation;
uniform vec2 uOrbitScale;
uniform float uOrbitMode;
uniform float uMotePhase;
varying vec3 vColor;
varying float vAlpha;
vec3 rotateAxes(vec3 p, vec3 rotation) {
  float cx = cos(rotation.x), sx = sin(rotation.x);
  float cy = cos(rotation.y), sy = sin(rotation.y);
  float cz = cos(rotation.z), sz = sin(rotation.z);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
  return vec3(p.x * cz - p.y * sz, p.x * sz + p.y * cz, p.z);
}
void main() {
  vec3 p = aPosition;
  if (uOrbitMode > 0.5) {
    p.xy *= uOrbitScale;
    float cp = cos(uMotePhase), sp = sin(uMotePhase);
    p = vec3(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
    p = rotateAxes(p, uOrbitRotation);
  }
  p = rotateAxes(p, uRotation);
  float pointDepth = uDepth - p.z;
  p.z -= uDepth;
  gl_Position = uProjection * vec4(p, 1.0);
  gl_PointSize = max(1.0, aSize * uPixelRatio * (5.0 / max(1.0, pointDepth)) * (1.0 + uEnergy * 0.7));
  vColor = aColor;
  vAlpha = aAlpha * (0.68 + uEnergy * 0.55);
}`

const fragmentShader = `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float glow = exp(-d * d * 5.0) * (1.0 - smoothstep(0.12, 1.0, d));
  gl_FragColor = vec4(vColor, glow * vAlpha);
}`

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`WebGL could not allocate shader ${type}; context lost: ${gl.isContextLost()}`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`OPI shader ${type} failed: ${message || 'empty compiler log'}; WebGL error: ${gl.getError()}`)
  }
  return shader
}

function createProgram(gl) {
  const program = gl.createProgram()
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexShader)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShader)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Could not link the OPI sphere shader.')
  }
  return program
}

function createStars(count = 1900) {
  const data = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const angle = goldenAngle * i
    const shell = i % 7 === 0 ? 1.28 : 1.04 + ((i * 37) % 19) / 100
    const hue = (i * 17) % 11
    const color = hue < 2 ? [0.88, 0.97, 1] : hue < 7 ? [0.31, 0.77, 1] : [0.2, 0.47, 0.95]
    const size = hue < 2 ? 1.9 + (i % 4) * 0.3 : 0.9 + (i % 5) * 0.19
    const alpha = hue < 2 ? 0.82 : 0.34 + ((i * 13) % 42) / 100
    data.push(Math.cos(angle) * radius * shell, y * shell, Math.sin(angle) * radius * shell, ...color, size, alpha)
  }
  return new Float32Array(data)
}

function createOrbitPoints(count = 360) {
  const data = []
  for (let i = 0; i <= count; i += 1) {
    const angle = (i / count) * Math.PI * 2
    data.push(Math.cos(angle), Math.sin(angle), 0)
  }
  return new Float32Array(data)
}

function createParticleBuffer(gl, data, dynamic = false) {
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW)
  return buffer
}

function projectionMatrix(aspect) {
  const f = 1 / Math.tan((36 * Math.PI) / 360)
  const near = 0.1
  const far = 100
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ])
}

export default function IntelligenceSphere({ mode = 'idle', audioLevelRef }) {
  const canvasRef = useRef(null)
  const graphicsStatusRef = useRef(null)
  const modeRef = useRef(mode)

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    const canvas = canvasRef.current
    const gl = canvas?.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'low-power' })
    if (!gl) {
      if (graphicsStatusRef.current) graphicsStatusRef.current.textContent = '3D rendering is unavailable in this browser.'
      return undefined
    }

    let program
    let frame = 0
    let animationId = 0
    let previousTime = 0
    let energy = 0
    let resizeObserver
    let onVisibilityChange
    const resources = []
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const hardware = navigator.hardwareConcurrency || 4
    const memory = navigator.deviceMemory || 4
    const profiles = [
      { name: 'low', stars: 760, orbits: 8, pixelRatio: 0.9, activeFps: 30, idleFps: 18 },
      { name: 'balanced', stars: 1320, orbits: 12, pixelRatio: 1.2, activeFps: 45, idleFps: 24 },
      { name: 'high', stars: 1900, orbits: 15, pixelRatio: 1.5, activeFps: 60, idleFps: 30 },
    ]
    let profileIndex = navigator.connection?.saveData || hardware <= 4 || memory <= 4 ? 0 : hardware <= 8 || memory <= 8 ? 1 : 2
    let profile = profiles[profileIndex]
    let lastRender = 0
    let qualityCheckAt = 0
    let slowFrames = 0
    let smoothFrames = 0
    let lastFpsReport = 0
    let fpsWindowFrames = 0

    try {
      program = createProgram(gl)
      gl.useProgram(program)
      const locations = {
        position: gl.getAttribLocation(program, 'aPosition'),
        color: gl.getAttribLocation(program, 'aColor'),
        size: gl.getAttribLocation(program, 'aSize'),
        alpha: gl.getAttribLocation(program, 'aAlpha'),
        projection: gl.getUniformLocation(program, 'uProjection'),
        rotation: gl.getUniformLocation(program, 'uRotation'),
        depth: gl.getUniformLocation(program, 'uDepth'),
        energy: gl.getUniformLocation(program, 'uEnergy'),
        pixelRatio: gl.getUniformLocation(program, 'uPixelRatio'),
        orbitRotation: gl.getUniformLocation(program, 'uOrbitRotation'),
        orbitScale: gl.getUniformLocation(program, 'uOrbitScale'),
        orbitMode: gl.getUniformLocation(program, 'uOrbitMode'),
        motePhase: gl.getUniformLocation(program, 'uMotePhase'),
      }

      const starBuffer = createParticleBuffer(gl, createStars())
      resources.push(starBuffer)
      const orbitBase = createOrbitPoints()
      const orbitSpecs = [
        { radius: 1.38, yScale: 0.6, tiltX: 0.18, tiltY: 0.12, tiltZ: 0.12, speedX: 0.12, speedY: -0.16, speedZ: 0.08, color: [0.35, 0.82, 1], opacity: 0.58 },
        { radius: 1.49, yScale: 0.76, tiltX: 1.2, tiltY: 0.25, tiltZ: -0.54, speedX: -0.11, speedY: 0.09, speedZ: 0.04, color: [0.78, 0.94, 1], opacity: 0.74 },
        { radius: 1.32, yScale: 0.91, tiltX: 2.08, tiltY: 0.72, tiltZ: 0.92, speedX: 0.06, speedY: 0.14, speedZ: -0.1, color: [0.2, 0.56, 1], opacity: 0.6 },
        { radius: 1.55, yScale: 0.54, tiltX: 0.55, tiltY: 1.35, tiltZ: 0.22, speedX: -0.07, speedY: -0.1, speedZ: 0.13, color: [0.44, 0.67, 1], opacity: 0.38 },
        { radius: 1.27, yScale: 0.82, tiltX: 1.68, tiltY: -0.7, tiltZ: 1.5, speedX: 0.1, speedY: 0.04, speedZ: -0.08, color: [0.82, 0.95, 1], opacity: 0.5 },
        { radius: 1.62, yScale: 0.72, tiltX: 0.85, tiltY: -1.1, tiltZ: 0.56, speedX: -0.045, speedY: 0.12, speedZ: 0.07, color: [0.28, 0.65, 1], opacity: 0.42 },
        { radius: 1.42, yScale: 1.0, tiltX: -0.28, tiltY: 0.4, tiltZ: 1.8, speedX: 0.14, speedY: -0.05, speedZ: -0.055, color: [0.66, 0.9, 1], opacity: 0.55 },
        { radius: 1.34, yScale: 0.7, tiltX: 2.35, tiltY: 0.22, tiltZ: -0.88, speedX: 0.08, speedY: -0.13, speedZ: 0.045, color: [0.56, 0.84, 1], opacity: 0.32 },
        { radius: 1.58, yScale: 0.68, tiltX: -0.62, tiltY: 0.92, tiltZ: 1.05, speedX: -0.09, speedY: 0.07, speedZ: -0.12, color: [0.8, 0.95, 1], opacity: 0.29 },
        { radius: 1.24, yScale: 0.94, tiltX: 1.42, tiltY: 1.32, tiltZ: -0.18, speedX: 0.055, speedY: 0.11, speedZ: 0.08, color: [0.34, 0.67, 1], opacity: 0.36 },
        { radius: 1.65, yScale: 0.5, tiltX: 0.95, tiltY: -0.42, tiltZ: 1.43, speedX: -0.12, speedY: -0.045, speedZ: 0.085, color: [0.61, 0.88, 1], opacity: 0.27 },
        { radius: 1.4, yScale: 0.88, tiltX: 2.6, tiltY: -1.02, tiltZ: 0.3, speedX: 0.035, speedY: 0.14, speedZ: -0.07, color: [0.91, 0.97, 1], opacity: 0.33 },
        { radius: 1.52, yScale: 0.83, tiltX: 0.32, tiltY: 1.74, tiltZ: -1.18, speedX: -0.08, speedY: 0.035, speedZ: 0.11, color: [0.39, 0.7, 1], opacity: 0.3 },
        { radius: 1.3, yScale: 0.57, tiltX: -1.1, tiltY: -0.32, tiltZ: 0.74, speedX: 0.13, speedY: 0.06, speedZ: -0.1, color: [0.74, 0.93, 1], opacity: 0.34 },
        { radius: 1.61, yScale: 0.9, tiltX: 1.92, tiltY: 0.54, tiltZ: 0.48, speedX: -0.035, speedY: -0.12, speedZ: 0.095, color: [0.25, 0.55, 1], opacity: 0.26 },
      ]
      const orbits = orbitSpecs.map((spec, index) => {
        const points = new Float32Array((orbitBase.length / 3) * 8)
        for (let i = 0; i < orbitBase.length / 3; i += 1) {
          const offset = i * 8
          points[offset] = orbitBase[i * 3]
          points[offset + 1] = orbitBase[i * 3 + 1]
          points[offset + 2] = orbitBase[i * 3 + 2]
          points[offset + 3] = spec.color[0]
          points[offset + 4] = spec.color[1]
          points[offset + 5] = spec.color[2]
          points[offset + 6] = 1.2
          points[offset + 7] = spec.opacity
        }
        const lineBuffer = createParticleBuffer(gl, points)
        resources.push(lineBuffer)
        const motes = new Float32Array(36 * 8)
        for (let i = 0; i < 36; i += 1) {
          const offset = i * 8
          const angle = (i / 36) * Math.PI * 2
          motes[offset] = Math.cos(angle)
          motes[offset + 1] = Math.sin(angle)
          motes[offset + 3] = spec.color[0]
          motes[offset + 4] = spec.color[1]
          motes[offset + 5] = spec.color[2]
          motes[offset + 6] = i % 6 === 0 ? 3.5 : 1.7
          motes[offset + 7] = spec.opacity
        }
        const moteBuffer = createParticleBuffer(gl, motes)
        resources.push(moteBuffer)
        return { ...spec, index, lineBuffer, moteBuffer, points, motes, pointCount: orbitBase.length / 3 }
      })

      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE)
      gl.clearColor(0, 0, 0, 0)

      function bind(buffer) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        const stride = 8 * Float32Array.BYTES_PER_ELEMENT
        gl.enableVertexAttribArray(locations.position)
        gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, stride, 0)
        gl.enableVertexAttribArray(locations.color)
        gl.vertexAttribPointer(locations.color, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT)
        gl.enableVertexAttribArray(locations.size)
        gl.vertexAttribPointer(locations.size, 1, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT)
        gl.enableVertexAttribArray(locations.alpha)
        gl.vertexAttribPointer(locations.alpha, 1, gl.FLOAT, false, stride, 7 * Float32Array.BYTES_PER_ELEMENT)
      }

      function resize() {
        if (!canvas || !gl) return
        const rect = canvas.getBoundingClientRect()
        const ratio = Math.min(window.devicePixelRatio || 1, profile.pixelRatio)
        const width = Math.max(1, Math.floor(rect.width * ratio))
        const height = Math.max(1, Math.floor(rect.height * ratio))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
          gl.viewport(0, 0, width, height)
          gl.useProgram(program)
          gl.uniformMatrix4fv(locations.projection, false, projectionMatrix(width / height))
          gl.uniform1f(locations.pixelRatio, ratio)
        }
      }

      function animate(now) {
        animationId = requestAnimationFrame(animate)
        const delta = Math.min((now - (previousTime || now)) / 1000, 0.05)
        previousTime = now
        const active = modeRef.current !== 'idle'
        const targetFps = reduceMotion ? Math.min(profile.idleFps, 20) : active ? profile.activeFps : profile.idleFps
        const frameInterval = 1000 / targetFps
        if (lastRender && now - lastRender < frameInterval) return
        const renderedDelta = lastRender ? now - lastRender : frameInterval
        lastRender = now
        fpsWindowFrames += 1

        if (qualityCheckAt === 0) qualityCheckAt = now
        if (now - qualityCheckAt >= 2000) {
          const observedFps = fpsWindowFrames * 1000 / (now - qualityCheckAt)
          if (observedFps < targetFps * 0.72) {
            slowFrames += 1
            smoothFrames = 0
          } else if (observedFps > targetFps * 0.92) {
            smoothFrames += 1
            slowFrames = 0
          }
          if (slowFrames >= 2 && profileIndex > 0) {
            profileIndex -= 1
            profile = profiles[profileIndex]
            resize()
            slowFrames = 0
            smoothFrames = 0
          } else if (smoothFrames >= 8 && profileIndex < 2) {
            profileIndex += 1
            profile = profiles[profileIndex]
            resize()
            slowFrames = 0
            smoothFrames = 0
          }
          fpsWindowFrames = 0
          qualityCheckAt = now
        }

        if (import.meta.env.DEV && now - lastFpsReport > 10000) {
          console.debug('[ONEXA performance]', {
            sphereFps: Math.round(1000 / Math.max(1, renderedDelta)),
            sphereQuality: profile.name,
            deviceMemoryGiB: navigator.deviceMemory || 'unavailable',
            heapUsedMiB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 'unavailable',
          })
          lastFpsReport = now
        }
        const currentMode = modeRef.current
        const currentLevel = audioLevelRef?.current || 0
        const motionScale = reduceMotion ? 0.28 : 1
        const targetEnergy = currentMode === 'speaking' || currentMode === 'listening'
          ? Math.min(1, Math.max(0.13, currentLevel * 1.9))
          : currentMode === 'thinking' ? 0.58 : 0.1
        energy += (targetEnergy - energy) * Math.min(1, delta * 3.2)
        frame += delta * motionScale
        gl.useProgram(program)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.uniform3f(locations.rotation, frame * 0.11, -frame * 0.16, frame * 0.035)
        gl.uniform1f(locations.depth, 4.05)
        gl.uniform1f(locations.energy, energy)
        gl.uniform1f(locations.orbitMode, 0)

        bind(starBuffer)
        gl.drawArrays(gl.POINTS, 0, profile.stars)

        for (let orbitIndex = 0; orbitIndex < profile.orbits; orbitIndex += 1) {
          const orbit = orbits[orbitIndex]
          gl.uniform1f(locations.orbitMode, 1)
          gl.uniform2f(locations.orbitScale, orbit.radius, orbit.radius * orbit.yScale)
          gl.uniform3f(
            locations.orbitRotation,
            orbit.tiltX + frame * orbit.speedX,
            orbit.tiltY + frame * orbit.speedY,
            orbit.tiltZ + frame * orbit.speedZ,
          )
          gl.uniform1f(locations.motePhase, 0)
          bind(orbit.lineBuffer)
          gl.drawArrays(gl.LINE_STRIP, 0, orbit.pointCount)

          gl.uniform1f(locations.motePhase, frame * (orbit.index % 2 ? -0.55 : 0.68))
          bind(orbit.moteBuffer)
          gl.drawArrays(gl.POINTS, 0, 36)
        }
      }

      let paused = document.visibilityState === 'hidden'
      onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          paused = true
          cancelAnimationFrame(animationId)
          animationId = 0
        } else if (paused) {
          paused = false
          previousTime = 0
          lastRender = 0
          animationId = requestAnimationFrame(animate)
        }
      }
      document.addEventListener('visibilitychange', onVisibilityChange)

      resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(canvas)
      resize()
      if (!paused) animationId = requestAnimationFrame(animate)
    } catch (error) {
      console.error('ONEXA sphere initialization failed:', error)
      if (graphicsStatusRef.current) graphicsStatusRef.current.textContent = 'The 3D intelligence visualization could not start in this browser.'
    }

    return () => {
      cancelAnimationFrame(animationId)
      resizeObserver?.disconnect()
      if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange)
      for (const resource of resources) gl.deleteBuffer(resource)
      if (program) gl.deleteProgram(program)
    }
  }, [audioLevelRef])

  return (
    <div className={`opi-sphere opi-sphere--${mode}`} aria-label={`ONEXA intelligence visualization, ${mode}`} role="img">
      <div className="sphere-aura" />
      <canvas ref={canvasRef} className="sphere-canvas" aria-hidden="true" />
      <div ref={graphicsStatusRef} className="sphere-graphics-status" />
      <div className="sphere-core-light" />
    </div>
  )
}
