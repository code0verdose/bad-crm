import { Color, Mesh, Program, Renderer, Triangle } from 'ogl';
import { useEffect, useRef } from 'react';

import classes from './aurora.module.css';

/*
 * Ported from React Bits (MIT) — see `SOURCE.md` in this directory for the origin and for the list
 * of changes. The shader itself is upstream's, unmodified: it is a simplex-noise ridge sampled
 * along x, ramped through three colour stops and faded out with a smoothstep.
 */

const VERTEX = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ),
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \
  int index = 0;                                            \
  for (int i = 0; i < 2; i++) {                               \
     ColorStop currentColor = colors[i];                    \
     bool isInBetween = currentColor.position <= factor;    \
     index = int(mix(float(index), float(i), float(isInBetween))); \
  }                                                         \
  ColorStop currentColor = colors[index];                   \
  ColorStop nextColor = colors[index + 1];                  \
  float range = nextColor.position - currentColor.position; \
  float lerpFactor = (factor - currentColor.position) / range; \
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;

  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

interface AuroraProps {
  /** Three hex colours, left to right. */
  colorStops: readonly [string, string, string];
  amplitude?: number;
  blend?: number;
  speed?: number;
}

export const Aurora = ({ colorStops, amplitude = 1, blend = 0.5, speed = 1 }: AuroraProps) => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = container.current;
    if (!node) return;

    /* WebGL is not always there — disabled by policy, missing in a VM, switched off in the
       browser. `ogl` throws out of its own constructor in that case, and an effect that throws
       takes the whole React root with it: the page would go blank because a decoration failed. */
    let renderer;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true });
    } catch {
      return;
    }

    const gl = renderer.gl;
    if (!gl) return;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const geometry = new Triangle(gl);
    // The shader reads `gl_FragCoord`, so the generated uv attribute is dead weight on every vertex.
    delete geometry.attributes['uv'];

    const program = new Program(gl, {
      vertex: VERTEX,
      fragment: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uColorStops: {
          value: colorStops.map((hex) => {
            const color = new Color(hex);
            return [color.r, color.g, color.b];
          }),
        },
        uResolution: { value: [node.offsetWidth, node.offsetHeight] },
        uBlend: { value: blend },
      },
    });

    const mesh = new Mesh(gl, { geometry, program });
    node.append(gl.canvas);

    const resize = () => {
      renderer.setSize(node.offsetWidth, node.offsetHeight);
      program.uniforms['uResolution'] = { value: [node.offsetWidth, node.offsetHeight] };
    };

    resize();
    globalThis.addEventListener('resize', resize);

    let frame = requestAnimationFrame(function draw(time: number) {
      frame = requestAnimationFrame(draw);
      program.uniforms['uTime'] = { value: time * 0.001 * speed };
      renderer.render({ scene: mesh });
    });

    return () => {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener('resize', resize);
      gl.canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [colorStops, amplitude, blend, speed]);

  return <div ref={container} className={classes['container']} aria-hidden="true" />;
};
