# Complex.js
A lightweight and easy-to-use library for you to manipulate complex numbers

## Features
- Lightweight
- Comprehensive
- Easy to use
- No dependencies
- 1000+ Test cases
- No INFINITY!!

## Install
```
npm install --save @rayyamhk/complex
```

## How to use
```
const Complex = require('@rayyamhk/complex');

const num1 = new Complex(3, 4); // 3 + 4i
const num2 = new Complex(-2); // -2 + 0i
const sum = Complex.add(num1, num2);
console.log(sum.toString()); // '1 + 4i'
```

## Build
```
npm install
npm run build
```
It creates a production version in `/build`

## Test
```
npm install
npm run test
```
It runs all tests in `/lib/tests`

## API
- [constructor](#constructorre-im)
- [Constant](#constant)
  - [Complex.NaN](#complexnan)
  - [Complex.ONE](#complexone)
  - [Complex.ZERO](#complexzero)
  - [Complex.PI](#complexpi)
  - [Complex.E](#complexe)
  - [Complex.EPSILON](#complexepsilon)
- [Instance methods](#instance-methods)
  - [getReal](#getreal)
  - [getImaginary](#getimaginary)
  - [getModulus](#getmodulus)
  - [getArgument](#getargument)
  - [toString](#tostring)
- [Static methods](#static-methods)
  - [isNaN](#isnannum)
  - [isEqual](#isequalnum1-num2-digit--15)
  - [add | subtract | multiply | divide](#4-basic-operations)
  - [conjugate](#conjugatenum)
  - [inverse](#inversenum)
  - [pow](#powbase-exponent)
  - [exp](#expnum)
  - [log](#lognum)
  - [sin | cos | tan | csc | sec | cot](#6-trigonometric-functions)
  - [asin | acos | atan | acsc | asec | acot](#6-inverse-of-trigonometric-functions)
### constructor(re, im)
```
@param { Number } re - Real part of the complex number
@param { Number } im - Imaginary part of the complex number
@return { Complex } Returns an instance of Complex
```
Note that the second argument, i.e. `im`, is optional.
```
new Complex(); // Complex.NaN
new Complex(3); // 3 + 0i
new Complex(Infinity); // Complex.NaN
new Complex('3'); // Complex.NaN
new Complex(3, 4); // 3 + 4i
new Complex(3, Infinity); // Complex.NaN
```

### Constant

#### Complex.NaN
It represents `NaN` in this library. It is equivalent to `new Complex(NaN)`. 
It is **important** to know that this library doesn't introduce the concept of `Complex Infinity`, all `Infinity` in this library 
are represented by `Complex.NaN`.
```
const num = new Complex(3, 4);
const quot = Complex.divide(num, Complex.ZERO); // Complex.NaN
```

#### Complex.ONE
It is equivalent to `new Complex(1)`

#### Complex.ZERO
It is equivalent to `new Complex(0)`

#### Complex.PI
It is equivalent to `new Complex(Math.PI)`

#### Complex.E
It is equivalent to `new Complex(Math.E)`

#### Complex.EPSILON
It represents the value of `5e-16`, which is the smallest number considered as `non-zero` in this library. In the other words, any number less than `Complex.EPSILON`
is considered as `0`. Note that `Complex.EPSILON` is `js Number` instead of instance of `Complex`.

### Instance methods

#### getReal()
```
@return { Number } - Returns the real part of the complex number
```
```
new Complex(3, 4).getReal(); // 3
new Complex(0, 1).getReal(); // 0
```

#### getImaginary()
```
@return { Number } - Returns the imaginary part of the complex number
```
```
new Complex(3, 4).getImaginary(); // 4
Complex.ZERO.getImaginary(); // 0
```

#### getModulus()
```
@return { Number } - Returns the modulus of the complex number 
```
Note that the modulus of the complex number is the length of the vector representing the complex number on complex plane.
```
new Complex(3, 4).getModulus(); // 5
Complex.ZERO.getModulus(); // 0
```

#### getArgument()
```
@return { Number } - Returns the argument of the complex number from the interval [0, 2π)
```
Note that the argument of the complex number is the angle between positive real-axis and the vector representing the complex number on complex plane.
```
new Complex(3, 3).getArgument(); // π/4
Complex.ZERO.getArgument(); // undefined
```

#### toString()
```
@return { String } - Returns the stringified complex number
```
```
new Complex(3, 4).toString(); // '3 + 4i'
new Complex(3.1415).toString(); // '3.1415'
Complex.NaN.toString(); // 'NaN'
```

### Static methods

#### isNaN(num)
```
@param { Complex } num
@return { Boolean } - Returns true if it is considered as NaN
```
It determines whether the given complex number is considered as NaN or not.
```
Complex.isNaN(new Complex(3)); // false
Complex.isNaN(new Complex(3, 4)); // false
Complex.isNaN(new Complex(Infinity)); // true
Complex.isNaN(Complex.NaN); // true
```

#### isEqual(num1, num2, digit = 15)
```
@param { Complex } num1
@param { Complex } num2
@param { Integer } [ digit = 15 ] - Number of significant digits
@return { Boolean } - Returns true if two complex numbers are considered as identical
```
It determines whether two complex numbers are considered as identical.
The optional argument `digit` limits the number of digits to check after the decimal point.\
The test criterion is `Math.abs(x - y) < 1 / (10 ** digit * 2)`. For default value 15, it should be `5e-16`.
That means if the difference of two numbers is less than `5e-16`, they are considered as same value.
```
const num1 = new Complex(3, 4);
const num2 = new Complex(3 + 4e-16, 4);
const num3 = new Complex(3 + 4e-16, 4 + 6e-16);
Complex.isEqual(num1, num2); // true as the diff of real parts is less than 5e-16
Complex.isEqual(num1, num3); // false as the diff of imaginary parts is greater than 5e-16

Complex.isEqual(Complex.NaN, new Complex(1 / 0)); // true as both are considered as NaN
```

#### 4 basic operations
```
@param { Complex } num1 - Complex number on the left of the operator
@param { Complex } num2 - Complex number on the right of the operator
@return { Complex } - Returns Sum | Difference | Product | Quotient of two numbers
```
Note that for `Complex.divide`, if the denominator, i.e. `num2`, is considered as `0`, it returns `Complex.NaN`.
```
const num1 = new Complex(3, 4);
const num2 = new Complex(-1, 2);

Complex.add(num1, num2); // 2 + 6i
Complex.subtract(num1, num2); // 4 + 2i
Complex.multiply(num1, num2); // -11 + 2i
Complex.divide(num1, num2); // 1 - 2i
Complex.divide(num1, Complex.ZERO); // Complex.NaN
```

#### conjugate(num)
```
@param { Complex } num
@return { Complex } - Returns the complex conjugate
```
Note that if the complex number is represented by `a + bi`, its complex conjugate is given by `a - bi`.
```
Complex.conjugate(new Complex(3, 4)); // 3 - 4i
Complex.conjugate(new Complex(3, -4)); // 3 + 4i
Complex.conjugate(new Complex(-3, 4)); // -3 - 4i
Complex.conjugate(new Complex(3)); // 3 - 0i
Complex.conjugate(Complex.NaN); // Complex.NaN
```

#### inverse(num)
```
@param { Complex } num
@return { Complex } - Returns the inverse
```
```
Complex.inverse(new Complex(3, 4)); // 3 / 25 - 4i / 25
Complex.inverse(Complex.ZERO); // Complex.NaN
```

#### pow(base, exponent)
```
@param { Complex } base
@param { Complex | Number } exponent
@return { Complex } - Returns the result of the exponentiation
```
The `exponent` can be either `js Number` or instance of `Complex`.\
You can find the k-th root of complex number by setting the exponent to `1 / k`. But you **should** know that it only returns one out of k possible solutions.
```
Complex.pow(z, 2); // z to the power of 2
Complex.pow(z, 1.234); // z to the power of 1.234
Complex.pow(z, 0); // Complex.ONE
Complex.pow(z, -2); // 1 divided by z to the power of 2
Complex.pow(z, 1 / 4); // one of the 4-th root of z
```

#### exp(num)
```
@param { Complex } num
@return { Complex } - Returns e to the power of num
```
```
Complex.exp(Complex.ZERO); // Complex.ONE
Complex.exp(new Complex(3, 4)); // -13.128783... - 15.200784463...i
```

#### log(num)
```
@param { Complex } num
@return { Complex } - Returns the result after taking natural log
```
It calculates the natural log of the complex number.\
Note that the complex log is a multivalued function, but this function only returns the principal value by restricting the imaginary part to the interval [0, 2π).
```
Complex.log(Complex.E); // Complex.ONE
Complex.log(Complex.ZERO); // Complex.NaN
```

#### 6 trigonometric functions
```
@param { Complex } num
@return { Complex } - Returns the result of the trigo functions
```
It calculates the value of sin, cos, tan, csc, sec, cot of the complex number.\
Note that if the argument is out of its domain, it returns `Complex.NaN`
```
Complex.sin(num); // Domain: entire complex plane C
Complex.cos(num); // Domain: entire complex plane C

Complex.tan(num); // Domain: entire complex plane C except the set { (2k+1)*π/2 : k is any integer }
Complex.tan(new Complex(Math.PI / 2)); // Complex.NaN

Complex.csc(num); // Domain: entire complex plane C except the set { kπ : k is any integer }
Complex.csc(Complex.ZERO); // Complex.NaN

Complex.sec(num); // Domain: entire complex plane C except the set { (2k+1)*π/2 : k is any integer }
Complex.sec(new Complex(Math.PI / 2)); // Complex.NaN

Complex.cot(num); // Domain: entire complex plane C except the set { kπ/2 : k is any integer }
Complex.cot(Complex.PI); // Complex.NaN
```

#### 6 inverse of trigonometric functions
```
@param { Complex } num
@return { Complex } - Returns the result of the inverse trigo functions
```
It calculates the value of arcsin, arccos, arctan, arccsc, arcsec, arccot of the complex number.\
Note that if the argument is out of its domain, it returns `Complex.NaN`
```
Complex.asin(num); // Domain: entire complex plane C
Complex.acos(num); // Domain: entire complex plane C
Complex.atan(num); // Domain: entire complex plane C except the set { i, -i }
Complex.acsc(num); // Domain: entire complex plane C except the set { 0 }
Complex.asec(num); // Domain: entire complex plane C except the set { 0 }
Complex.acot(num); // Domain: entire complex plane C except the set { i, -i , 0 }
```

## How to contribute
You are welcome to contribute by:
- Reporting bugs
- Fixing bugs
- Adding new features
- Improving performance
- Improving code style of this library

## Copyright & License
Copyright (C) 2020 Ray Yam

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
