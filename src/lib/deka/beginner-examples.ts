// Small, executable steps before the interactive app examples.
export const beginnerExamples = [
  {
    name: 'Hello, world!', slug: 'hello-world', section: 'Getting started',
    source: `export fn App() {
    return (
        <view>
            <p>Hello, world!</p>
        </view>
    );
}
`,
    expectedText: ['Hello, world!'],
    content: `Welcome! You do not need any programming experience. The code in the editor tells the computer what to display. Its result appears in the preview.

**Try it:** change **Hello, world!** to your own greeting. The preview updates as you edit; you can also click **Run**.

\`<view>\` contains the screen and \`<p>\` contains a paragraph. Closing tags, like \`</p>\`, mark where each part ends.

Keep the outer structure for now. We will introduce it step by step.`,
  },
  {
    name: 'Comments', slug: 'comments', section: 'Getting started',
    source: `export fn App() {
    // This is a note for the person reading the code.
    // The computer skips these two lines.
    return (
        <view>
            <p>My first program</p>
        </view>
    );
}
`,
    expectedText: ['My first program'],
    content: `A **comment** explains code to a person. It does not add anything to your app's output.

Two slashes, \`//\`, start a comment. Everything after them on that line is ignored when the program runs.

**Try it:** change the words after \`//\`. The preview should stay the same. Then change **My first program** inside the paragraph: that change does appear.

Comments are useful for recording why you wrote something or leaving yourself a reminder.`,
  },
  {
    name: 'Giving values names', slug: 'named-values', section: 'Getting started',
    source: `export fn App() {
    const name = "Sam";

    return (
        <view>
            <p>Hello, {name}!</p>
        </view>
    );
}
`,
    expectedText: ['Hello, Sam!'],
    content: `A **value** is a piece of information, such as a name or a number. Giving it a name lets you use it elsewhere in your program.

\`const name = "Sam";\` gives the name **name** to the text **Sam**. The equals sign assigns the value. Quotation marks tell the computer that Sam is text; the semicolon ends the instruction.

Inside a paragraph, \`{name}\` means “use the value named name here.” These braces insert a value into the text. Without them, the word **name** would appear literally.

**Try it:** change \`"Sam"\` to your own name. Then use \`{name}\` twice in the paragraph.

\`const\` means the program cannot assign a different value to this name later. Editing the source starts a new run, so you can still change it in the editor.`,
  },
  {
    name: 'Numbers and calculations', slug: 'numbers', section: 'Getting started',
    source: `export fn App() {
    const apples = 8;
    const pears = 4;

    return (
        <view>
            <p>Total fruit: {apples + pears}</p>
            <p>Apples left after eating two: {apples - 2}</p>
            <p>Twice as many pears: {pears * 2}</p>
            <p>Apples per person, shared by two: {apples / 2}</p>
        </view>
    );
}
`,
    expectedText: ['Total fruit: 12', 'Apples left after eating two: 6', 'Twice as many pears: 8', 'Apples per person, shared by two: 4'],
    content: `Numbers are written without quotation marks. You can calculate with them using \`+\` to add, \`-\` to subtract, \`*\` to multiply and \`/\` to divide.

\`apples + pears\` is an **expression**: a piece of code that produces a value. The braces in the paragraph display its result.

**Try it:** change \`apples\` from **8** to **10**. Before running it, predict which lines will change. The total becomes **14**, the remaining apples **8**, and the share **5**. The pears stay the same.

Like ordinary arithmetic, multiplication and division happen before addition and subtraction. Parentheses let you group a calculation, such as \`(apples + pears) * 2\`.`,
  },
  {
    name: 'Working with text', slug: 'strings', section: 'Getting started',
    source: `export fn App() {
    const first = "Sam";
    const last = "River";
    const fullName = first + " " + last;

    return (
        <view>
            <p>{fullName}</p>
            <p>Welcome to your app!</p>
        </view>
    );
}
`,
    expectedText: ['Sam River', 'Welcome to your app!'],
    content: `Programmers call a piece of text a **string**. In code, quotation marks mark where a string starts and ends. They are not part of the displayed text.

The \`+\` operator joins strings. Here, \`first + " " + last\` joins two names with a space in between. Even a single space can be a string.

Notice the difference between \`{fullName}\`, which displays a named value, and **Welcome to your app!**, which is text written directly inside the paragraph.

**Try it:** change both names. Then remove the space between them by changing \`" "\` to \`""\`, an empty string. What happens?`,
  },
  {
    name: 'True and false', slug: 'booleans', section: 'Getting started',
    source: `export fn App() {
    const lightsOn = true;
    const message = lightsOn ? "The lights are on" : "The lights are off";

    return (
        <view>
            <p>{message}</p>
        </view>
    );
}
`,
    expectedText: ['The lights are on'],
    content: `Some information has two possibilities: yes or no, on or off. A **boolean** is a value that is either \`true\` or \`false\`. Write these words without quotes.

The expression \`lightsOn ? "The lights are on" : "The lights are off"\` chooses between two values. Read it as: “if lightsOn is true, use the first message; otherwise, use the second.” The question mark and colon separate the choices.

**Try it:** change \`true\` to \`false\`. The preview should say **The lights are off**.

Comparisons also produce booleans. Try replacing \`true\` with \`2 < 3\`. Here, \`<\` asks whether the left number is less than the right one.`,
  },
  {
    name: 'Making decisions', slug: 'decisions', section: 'Getting started',
    source: `export fn App() {
    const temperature = 12;
    let advice = "Enjoy the sunshine";

    if (temperature < 15) {
        advice = "Bring a jacket";
    }

    return (
        <view>
            <p>{advice}</p>
        </view>
    );
}
`,
    expectedText: ['Bring a jacket'],
    content: `An **if** statement runs some instructions only when a condition is true. A condition is a question your program can answer with true or false.

\`temperature < 15\` asks whether the temperature is less than 15. When it is, the instructions inside the following braces run.

This time we use \`let advice\` instead of \`const advice\`. A name declared with **let** can be assigned a new value. The program starts with one message and changes it when a jacket is needed.

**Try it:** change the temperature to **20**. You should see **Enjoy the sunshine**. Try **15** too: less than does not include equal to.`,
  },
  {
    name: 'Lists of values', slug: 'arrays', section: 'Getting started',
    source: `export fn App() {
    const fruits = ["Apple", "Pear", "Orange"];

    return (
        <view>
            <p>First fruit: {fruits.has(0) ? fruits[0] : "No fruit"}</p>
            <p>Second fruit: {fruits.has(1) ? fruits[1] : "No fruit"}</p>
            <p>Third fruit: {fruits.has(2) ? fruits[2] : "No fruit"}</p>
        </view>
    );
}
`,
    expectedText: ['First fruit: Apple', 'Second fruit: Pear', 'Third fruit: Orange'],
    content: `An **array** keeps several values together in an ordered list. Square brackets surround the list and commas separate its items.

You can read an item using its position, called an **index**. Positions start at **0**, so \`fruits[0]\` is Apple, \`fruits[1]\` is Pear and \`fruits[2]\` is Orange.

Before reading a position, DekaScript asks you to check that it exists. \`fruits.has(0)\` checks the first position. The choice expression displays that fruit if it exists, or **No fruit** otherwise. This makes a shorter list safe to use.

**Try it:** replace Pear with your favourite fruit. Only the second line should change. Then swap the first and third items in the array.

Later, you will turn a whole list into buttons without writing a separate paragraph for every item.`,
  },
  {
    name: 'Your first function', slug: 'first-function', section: 'Getting started',
    source: `fn double(value: number) number {
    return value * 2;
}

export fn App() {
    const answer = double(3);

    return (
        <view>
            <p>The answer is {answer}</p>
        </view>
    );
}
`,
    expectedText: ['The answer is 6'],
    content: `A **function** is a named set of instructions that you can reuse. You have already used App; now you are defining another function called **double**.

\`value\` is its input, called a **parameter**. \`: number\` says that input must be a number. The \`number\` after the parentheses says the function returns a number too. These descriptions are called **types**.

\`return value * 2;\` sends the calculated result back to whoever called the function. Writing \`double(3)\` calls it with 3, producing 6.

**Try it:** change \`double(3)\` to \`double(10)\`. The answer should become **20**. Try a quoted word instead of a number to see how DekaScript helps catch a mistake, then undo that edit.

Next, we will use these foundations to build apps that respond to clicks. You can return to any lesson from **Contents**.`,
  },
]
