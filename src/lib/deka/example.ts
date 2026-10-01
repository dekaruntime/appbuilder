import { beginnerExamples } from './beginner-examples'

export const bindingsSource = `export fn App() {
    let count = 0;
    let other = 10;

    return (
        <view className="p-4 gap-2 bg-[#F3EFE3] text-[#1A1611]">
            <p className="text-xl">A view. A binding. No React.</p>
            <p>State lives in the VM. Rust draws the view.</p>
            <p className="text-xl">Count: {count}</p>
            <div className="flex-row gap-3">
                <button onClick={fn() { count += 1; }}>Add one</button>
                <button onClick={fn() { count = 0; }}>Reset count</button>
            </div>
            <p>Independent value: {other}</p>
            <button onClick={fn() { other += 10; }}>Change other</button>
        </view>
    );
}
`

export const initialSource = `export fn App() {
    let count = 0;

    return (
        <view className="flex flex-col gap-4 p-6 bg-[#F3EFE3] text-[#1A1611]">
            <span className="text-2xl">Deka, native.</span>
            <span>The same UI, inside your browser.</span>
            <div className="flex flex-row gap-4">
                <button className="p-4 rounded-lg bg-[#0C8B43] text-[#ffffff]"
                    onClick={fn() { count = count + 1; }}>
                    Add one
                </button>
                <button className="p-4 rounded-lg bg-[#5946AD] text-[#ffffff]"
                    onClick={fn() { count = count - 1; }}>
                    Subtract one
                </button>
            </div>
            <span className="text-xl">Count: {count}</span>
        </view>
    );
}
`

export const layoutSource = `export fn App() {
    let count = 0;
    return (
        <view className="w-full h-full p-4 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            <span className="text-xl">Boxes and text</span>
            <div className="w-full h-24 flex-row items-center justify-between px-4 bg-[#E2DCCF] shrink-0">
                <div className="w-12 h-12 bg-[#663399] rounded" />
                <div className="w-20 h-8 bg-[#0C8B43] rounded" />
            </div>
            <div className="w-full flex-row flex-wrap gap-2">
                <button className="w-24 h-10 p-2 shrink-0 bg-[#663399] text-[#ffffff]"
                    onClick={fn() { count = count + 1; }}>Count: {count}</button>
                <span className="w-40">Resize the preview. These words wrap inside their box.</span>
            </div>
            <div className="w-40 h-8 overflow-hidden shrink-0 bg-[#E2DCCF]">
                <span className="w-80 whitespace-nowrap">This text extends past the clipping boundary.</span>
            </div>
        </view>
    );
}
`

export const fadeSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-3 bg-[#F3EFE3]">
            <button className="w-40 bg-[#663399] text-[#ffffff]" onClick={fn() { open = 1 - open; }}>Toggle modal</button>
            <div className="w-full h-56 shrink-0 items-center justify-center overflow-hidden bg-[#E2DCCF]">
                <div className={open == 1 ? "w-64 p-4 gap-3 rounded-lg bg-[#ffffff] opacity-100 transition-opacity duration-500 ease-out" : "w-64 p-4 gap-3 rounded-lg bg-[#ffffff] opacity-0 transition-opacity duration-500 ease-out"}>
                    <span className="text-xl">A quiet entrance</span>
                    <span>This card fades in and out. Click again midway to reverse it.</span>
                    <button className="bg-[#663399] text-[#ffffff]" onClick={fn() { open = 0; }}>Dismiss</button>
                </div>
            </div>
        </view>
    );
}
`

export const menuSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-3 bg-[#F3EFE3]">
            <button className="w-40 bg-[#663399] text-[#ffffff]" onClick={fn() { open = 1 - open; }}>Toggle menu</button>
            <div className="w-full h-52 overflow-hidden bg-[#E2DCCF]">
                <div className={open == 1 ? "w-56 h-full p-4 gap-4 bg-[#663399] text-[#ffffff] translate-x-0 transition-transform duration-500 ease-out" : "w-56 h-full p-4 gap-4 bg-[#663399] text-[#ffffff] -translate-x-56 transition-transform duration-500 ease-out"}>
                    <span className="text-xl">Your workspace</span>
                    <span>Projects</span>
                    <span>Activity</span>
                    <button className="bg-[#ffffff] text-[#663399]" onClick={fn() { open = 0; }}>Close menu</button>
                </div>
            </div>
        </view>
    );
}
`

export const growSource = `export fn App() {
    let large = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3] items-start">
            <span className="text-xl">Make room</span>
            <button className={large == 1 ? "w-64 h-20 bg-[#0C8B43] text-[#ffffff] transition-all duration-600 ease-in-out" : "w-40 h-12 bg-[#663399] text-[#ffffff] transition-all duration-600 ease-in-out"}
                onClick={fn() { large = 1 - large; }}>Click to resize</button>
            <span className="w-64">The next box moves as the button grows. This is animated layout, not a stretched image.</span>
        </view>
    );
}
`

export const toastSource = `export fn App() {
    let visible = 0;
    return (
        <view className="w-full h-full p-4 gap-3 bg-[#F3EFE3]">
            <button className="w-40 bg-[#663399] text-[#ffffff]" onClick={fn() { visible = 1 - visible; }}>Toggle toast</button>
            <div className="w-full h-52 overflow-hidden justify-end items-end bg-[#E2DCCF]">
                <div className={visible == 1 ? "w-64 p-4 gap-2 rounded-lg bg-[#0C8B43] text-[#ffffff] opacity-100 translate-y-0 transition-all duration-500 ease-out" : "w-64 p-4 gap-2 rounded-lg bg-[#0C8B43] text-[#ffffff] opacity-0 translate-y-24 transition-all duration-500 ease-out"}>
                    <span className="text-xl">Changes saved</span>
                    <span>A little motion makes the message easy to notice.</span>
                </div>
            </div>
        </view>
    );
}
`

export const springSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle spring motion</button>
            <span>Click again while it moves to reverse the spring.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                <div className={open == 1 ? "w-20 h-20 rounded-lg bg-[#663399] translate-x-48 transition-transform spring spring-damping-9" : "w-20 h-20 rounded-lg bg-[#663399] translate-x-0 transition-transform spring spring-damping-9"} />
            </div>
        </view>
    );
}
`

export const keyframesSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle keyframes</button>
            <span>Custom keyframes, repeated and alternated. Toggle to stop.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                <div className={open == 1 ? "w-20 h-20 rounded-lg bg-[#0C8B43] frames-x-[0:0,25:80,75:160,100:0] frames-scale-[0:1,50:1.3,100:1] duration-1400 repeat-infinite alternate" : "w-20 h-20 rounded-lg bg-[#0C8B43] animate-none"} />
            </div>
        </view>
    );
}
`

export const transformSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle scale and rotation</button>
            <span>The hit area moves with the transformed button.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                <button className={open == 1 ? "w-32 h-20 rounded-lg bg-[#663399] text-[#ffffff] scale-125 rotate-20 transition-transform duration-700" : "w-32 h-20 rounded-lg bg-[#663399] text-[#ffffff] scale-100 rotate-0 transition-transform duration-700"} onClick={fn() {open = 1 - open;}}>Click me too</button>
            </div>
        </view>
    );
}
`

export const presenceSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle enter and exit</button>
            <span>Toggle mounts and unmounts the card.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                {open == 1 ? <div className="w-64 p-4 gap-3 rounded-lg bg-[#ffffff] enter-scale exit-slide duration-600"><span className="text-xl">Hello again</span><span>Mounted on entry, visually retained during exit.</span></div> : None}
            </div>
        </view>
    );
}
`

export const layoutMotionSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle layout movement</button>
            <span>Changing alignment gives the box a new layout destination.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                <div className={open == 1 ? "w-full h-28 flex-row justify-end bg-[#E2DCCF]" : "w-full h-28 flex-row justify-start bg-[#E2DCCF]"}><div className="w-20 h-20 shrink-0 rounded-lg bg-[#0C8B43] transition-layout spring" /></div>
            </div>
        </view>
    );
}
`

export const staggerSource = `export fn App() {
    let open = 0;
    return (
        <view className="w-full h-full p-4 gap-4 bg-[#F3EFE3]">
            <button className="w-48 bg-[#663399] text-[#ffffff]" onClick={fn() {open = 1 - open;}}>Toggle staggered entrance</button>
            <span>A parent spaces its children's entrances by 120ms.</span>
            <div className="w-full h-64 p-8 gap-3 overflow-hidden">
                {open == 1 ? <div className="w-64 gap-3 stagger-120"><div className="p-3 bg-[#663399] text-[#ffffff] enter-slide exit-fade duration-400">Projects</div><div className="p-3 bg-[#663399] text-[#ffffff] enter-slide duration-400">Activity</div><div className="p-3 bg-[#663399] text-[#ffffff] enter-slide duration-400">Settings</div></div> : None}
            </div>
        </view>
    );
}
`

export const valuesSource = `export fn App() {
    // const bindings cannot be reassigned; let bindings can.
    const language = "DekaScript";
    const release = { major: 0, minor: 60 };
    let clicks = 0;
    return (
        <view className="p-6 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            <p className="text-2xl">Hello, {language}</p>
            <p>Minor version: {release.minor}</p>
            <p>Clicks: {clicks}</p>
            <button onClick={fn() { clicks += 1; }}>Change a binding</button>
        </view>
    );
}
`

export const functionsSource = `fn twice(value: number) number {
    return value * 2;
}

export fn App() {
    let value = 3;
    return (
        <view className="p-6 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            <p className="text-xl">Functions calculate values</p>
            <p>Input: {value}</p>
            <p>Doubled: {twice(value)}</p>
            <button onClick={fn() { value += 1; }}>Next number</button>
        </view>
    );
}
`

export const listsSource = `export fn App() {
    const projects = ["Deka", "Zega", "My next idea"];
    let selected = "Choose a project";
    return (
        <view className="p-6 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            <p className="text-xl">{selected}</p>
            {projects.map(fn(name: string) {
                return (<button className={selected == name ? "p-3 bg-[#0C8B43] text-[#ffffff]" : "p-3 bg-[#E2DCCF]"}
                    onClick={fn() { selected = name; }}>{name}</button>);
            })}
        </view>
    );
}
`

export const componentsSource = `fn Card(title: string, detail: string) {
    return (
        <div className="p-4 gap-2 rounded-lg bg-[#ffffff]">
            <p className="text-xl">{title}</p>
            <p>{detail}</p>
        </div>
    );
}

export fn App() {
    return (
        <view className="p-4 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            {Card("Deka", "A component is a function that returns a view.")}
            {Card("Your project", "Reuse the structure with different arguments.")}
        </view>
    );
}
`

export const flowSource = `fn total(values: Array<number>) number {
    let result = 0;
    for (let i = 0; i < 3; i += 1) {
        if (values.has(i)) { result += values[i]; }
    }
    return result;
}

export fn App() {
    const values = [3, 5, 8];
    let open = 0;
    return (
        <view className="p-6 gap-3 bg-[#F3EFE3] text-[#1A1611]">
            <p className="text-xl">Loops and conditions</p>
            <p>Total: {total(values)}</p>
            <button onClick={fn() {
                if (open == 0) { open = 1; } else { open = 0; }
            }}>Toggle answer</button>
            {open == 1 ? <p>The total is 16.</p> : None}
        </view>
    );
}
`

// Each active lesson is executed against the shipped VM WASM in CI.
export const nativeExamples = [
  ...beginnerExamples,
  { name: 'Values and bindings', slug: 'values', section: 'Language', source: valuesSource,
    content: 'Use **const** for values that stay fixed and **let** for state that changes. Objects have named fields. Click the button, then change the initial value of clicks. Source edits restart the app.' },
  { name: 'Functions', slug: 'functions', section: 'Language', source: functionsSource,
    content: 'Functions take typed arguments and return values. The expression inside braces calls **twice** when state updates. Change the multiplier and run it.' },
  { name: 'Control flow', slug: 'control-flow', section: 'Language', source: flowSource,
    content: 'A loop calculates a total. The button uses **if / else** to change state. A conditional child returns a view or **None**, which draws nothing.' },
  { name: 'Bindings without React', slug: 'bindings', section: 'Views', source: bindingsSource,
    content: 'The component runs once to create its state and bindings. Events change that state. The VM evaluates bindings after an event; Rust owns layout and presentation. No React hooks are needed. Idle animation frames do not execute DekaScript.' },
  { name: 'Counter', slug: 'counter', section: 'Views', source: initialSource,
    content: 'A **view** contains primitives: containers, text and buttons. Click **Add one**, then change its handler to add two. The compiler and VM run in WASM; WebGL paints the Rust scene. Successful edits restart state. Errors keep the last working app.' },
  { name: 'Reusable components', slug: 'components', section: 'Views', source: componentsSource,
    content: 'Call a function to reuse a group of primitives. Here, **Card** receives two strings and returns markup. Both cards use the same structure. Local module imports are not yet available in this browser showcase.' },
  { name: 'Lists and selection', slug: 'lists', section: 'Views', source: listsSource,
    content: 'Map an immutable array into buttons. Each callback captures its own project name. Selection changes both the heading and the selected button style. Add another project to the array.' },
  { name: 'Layout basics', slug: 'layout', section: 'Layout', source: layoutSource,
    content: 'Try **items-center**, **justify-between**, **flex-wrap** and **overflow-hidden**. Resize the browser to see text and rows wrap. Layout and clipping come from Rust; browser CSS does not style these primitives.' },
  { name: 'Modal fade', slug: 'fade', section: 'Motion', source: fadeSource,
    content: 'Opacity transitions animate in Rust between state changes. Change **duration-500** to **duration-1000**, then reverse midway. This demonstrates a modal entrance; focus trapping and dialog semantics are not yet provided.' },
  { name: 'Sliding menu', slug: 'menu', section: 'Motion', source: menuSource,
    content: 'Translation moves a menu inside its clipping boundary. Change **ease-out** to **ease-linear**. Hit testing follows the presented position.' },
  { name: 'Growing button', slug: 'grow', section: 'Motion', source: growSource,
    content: 'Animate width, height and color with **transition-all**. Nearby elements move as layout changes. Change the destination dimensions.' },
  { name: 'Toast notification', slug: 'toast', section: 'Motion', source: toastSource,
    content: 'Combine opacity and translation for a notification entrance. This is a presentation example with manual dismissal; it does not start an automatic timer.' },
  { name: 'Spring motion', slug: 'spring', section: 'Motion', source: springSource,
    content: 'A spring tracks its current position and velocity. Change **spring-damping-9** and click again while it moves.' },
  { name: 'Keyframes', slug: 'keyframes', section: 'Motion', source: keyframesSource,
    content: 'Define positions along a timeline, repeat them and alternate direction. Toggle the animation off. Reduced-motion preferences stop continuous movement.' },
  { name: 'Scale and rotation', slug: 'transforms', section: 'Motion', source: transformSource,
    content: 'Transform a button and click it at its new position. Rust transforms text, paint and hit areas together.' },
  { name: 'Enter and exit', slug: 'presence', section: 'Motion', source: presenceSource,
    content: 'Return a card or **None**. Rust retains its presentation long enough to animate the exit. Exiting content is not interactive.' },
  { name: 'Layout movement', slug: 'layout-motion', section: 'Motion', source: layoutMotionSource,
    content: 'Changing alignment moves a box to a new destination. **transition-layout spring** animates the move.' },
  { name: 'Staggered entrance', slug: 'stagger', section: 'Motion', source: staggerSource,
    content: 'A parent delays each child entrance by **120ms**. Change the stagger value and toggle the group. The system reduced-motion preference also applies.' },
]
